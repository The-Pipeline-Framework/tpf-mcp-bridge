import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createTpfMcpServer, type TpfMcpHandlers } from "./mcp-server.js";
import { createMcpSamplingPlannerClient, createOpenAiPlannerClient } from "./planner-client.js";
import { resolvePlannerCredential, type PlannerCredentialSource } from "./credential-resolution.js";
import { BriefSessionService } from "./session-service.js";
import { InMemoryArtifactStore, InMemorySessionStore, LocalFileArtifactStore, type SessionStore } from "./storage.js";
import type {
  AnalyzeResult,
  BriefInput,
  GenerateSessionInput,
  PlannerProfile,
  PlannerProviderMode,
  PlannerTransportMode,
  ScaffoldResult,
  SessionResult,
  SessionState
} from "./types.js";

export interface BridgeConfig {
  apiBaseUrl?: string;
  apiToken?: string;
  llmEndpoint?: string;
  llmModel?: string;
  llmToken?: string;
  llmCredentialSource?: PlannerCredentialSource;
  llmProfile?: PlannerProfile;
  llmProviderMode?: PlannerProviderMode;
  plannerTransportMode?: PlannerTransportMode;
  backendFetchImpl?: typeof fetch;
  providerFetchImpl?: typeof fetch;
}

interface StoredSessionPayload {
  session: SessionState;
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const apiBaseUrl = env.TPF_MCP_API_BASE_URL?.trim() || undefined;
  const apiToken = env.TPF_MCP_API_TOKEN?.trim() || undefined;
  const plannerTransportMode = readPlannerTransportMode(env.TPF_LLM_TRANSPORT_MODE ?? env.TPF_LLM_TRANSPORT);
  const llmProviderMode = readPlannerProviderMode(env.TPF_LLM_PROVIDER_MODE);
  const llmEndpoint = optionalEnv(env, "TPF_LLM_ENDPOINT");
  const llmModel = optionalEnv(env, "TPF_LLM_MODEL");
  const credential = resolveOptionalPlannerCredential(env, llmProviderMode, plannerTransportMode);
  const llmProfile = readPlannerProfile(env.TPF_LLM_PROFILE);

  return {
    apiBaseUrl,
    apiToken,
    llmEndpoint,
    llmModel,
    llmToken: credential.token,
    llmCredentialSource: credential.source,
    llmProfile,
    llmProviderMode,
    plannerTransportMode
  };
}

export function createBridgeHandlers(
  config: BridgeConfig,
  getServer?: () => McpServer | undefined
): TpfMcpHandlers {
  return config.apiBaseUrl
    ? createHostedBridgeHandlers(config, getServer)
    : createLocalBridgeHandlers(config, getServer);
}

export function createLocalBridgeHandlers(
  config: BridgeConfig,
  getServer?: () => McpServer | undefined
): TpfMcpHandlers {
  const sessionStore = new InMemorySessionStore();
  const artifactStore = new LocalFileArtifactStore();
  const service = () => new BriefSessionService(
    sessionStore,
    artifactStore,
    resolveBridgePlannerClient(config, getServer)
  );

  return {
    analyzeBrief: unsupportedAnalyzeBriefTool,
    scaffoldFromBrief: unsupportedScaffoldTool,
    startBriefSession: (input) => service().startSession(input),
    answerContractQuestions: (input) => service().answerQuestions(input),
    getBriefSession: (input) => service().getSession(input),
    generateScaffold: (input) => service().generateScaffold(input)
  };
}

export function createHostedBridgeHandlers(
  config: BridgeConfig,
  getServer?: () => McpServer | undefined
): TpfMcpHandlers {
  if (!config.apiBaseUrl) {
    throw new Error("Hosted bridge mode requires TPF_MCP_API_BASE_URL.");
  }

  const sessionStore = new HostedSessionStore(config);
  const artifactStore = new InMemoryArtifactStore();
  const service = () => new BriefSessionService(
    sessionStore,
    artifactStore,
    resolveBridgePlannerClient(config, getServer)
  );

  return {
    analyzeBrief: unsupportedAnalyzeBriefTool,
    scaffoldFromBrief: unsupportedScaffoldTool,
    startBriefSession: (input) => service().startSession(input),
    answerContractQuestions: (input) => service().answerQuestions(input),
    getBriefSession: async (input) => {
      const session = await sessionStore.get(input.sessionId);
      if (!session) {
        throw new Error(`Unknown session '${input.sessionId}'.`);
      }
      return sessionToResult(session);
    },
    generateScaffold: async (input) => requestBackend<SessionResult>(config, "generate-scaffold", {
      method: "POST",
      body: JSON.stringify(input)
    })
  };
}

export async function startBridgeServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readBridgeConfig(env);
  let serverRef: McpServer | undefined;
  const server = createTpfMcpServer(createBridgeHandlers(config, () => serverRef), {
    includeCompatibilityTools: false,
    errorMapper: (error) => toBridgeMcpError(error, config)
  });
  serverRef = server;
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
}

class HostedSessionStore implements SessionStore {
  constructor(private readonly config: BridgeConfig) {}

  async get(sessionId: string): Promise<SessionState | undefined> {
    const payload = await requestBackend<StoredSessionPayload | undefined>(
      this.config,
      `session?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "GET" },
      { returnUndefinedOn404: true }
    );
    return payload?.session;
  }

  async put(session: SessionState): Promise<void> {
    await requestBackend<StoredSessionPayload>(this.config, "session", {
      method: "POST",
      body: JSON.stringify({ session })
    });
  }
}

async function requestBackend<T>(
  config: BridgeConfig,
  pathname: string,
  init?: RequestInit,
  options: { returnUndefinedOn404?: boolean } = {}
): Promise<T> {
  if (!config.apiBaseUrl) {
    throw new Error("Hosted backend is not configured.");
  }

  const fetchImpl = config.backendFetchImpl ?? fetch;
  const url = new URL(pathname, ensureTrailingSlash(config.apiBaseUrl));
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}),
      ...(init?.headers || {})
    }
  });

  if (options.returnUndefinedOn404 && response.status === 404) {
    return undefined as T;
  }

  const payload = await response.json().catch(async () => ({
    error: await response.text()
  }));
  if (!response.ok) {
    const message = typeof payload?.error === "string"
      ? payload.error
      : `Hosted TPF backend request failed (${response.status}).`;
    throw new Error(`Hosted TPF backend request failed (${response.status}): ${message}`);
  }
  return payload as T;
}

function sessionToResult(session: SessionState): SessionResult {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    generationCount: session.generationCount,
    ...(session.lastArtifact ? { artifact: session.lastArtifact } : {}),
    ...session.analysis
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function formatBridgeConfigSummary(config: BridgeConfig): string {
  return [
    `plannerTransport=${config.plannerTransportMode ?? "direct-http"}`,
    `providerMode=${config.llmProviderMode ?? "openai-compatible"}`,
    `credentialSource=${config.llmCredentialSource ?? "unknown"}`,
    `apiBaseUrl=${config.apiBaseUrl ? "configured" : "local-only"}`
  ].join(", ");
}

export function toBridgeMcpError(error: unknown, config?: BridgeConfig): McpError {
  const message = error instanceof Error ? error.message : String(error);
  const suffix = config ? ` [${formatBridgeConfigSummary(config)}]` : "";
  return new McpError(ErrorCode.InternalError, `${message}${suffix}`);
}

function readPlannerProfile(rawValue: string | undefined): PlannerProfile {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "full") {
    return "full";
  }
  if (normalized === "compact") {
    return "compact";
  }
  throw new Error(`Unsupported TPF_LLM_PROFILE '${rawValue}'. Allowed values: full, compact.`);
}

function readPlannerProviderMode(rawValue: string | undefined): PlannerProviderMode {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "openai-compatible") {
    return "openai-compatible";
  }
  if (normalized === "ollama-native") {
    return "ollama-native";
  }
  throw new Error(
    `Unsupported TPF_LLM_PROVIDER_MODE '${rawValue}'. Allowed values: openai-compatible, ollama-native.`
  );
}

function readPlannerTransportMode(rawValue: string | undefined): PlannerTransportMode {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "direct-http") {
    return "direct-http";
  }
  if (normalized === "auto") {
    return "auto";
  }
  if (normalized === "mcp-sampling") {
    return "mcp-sampling";
  }
  throw new Error(
    `Unsupported TPF_LLM_TRANSPORT_MODE '${rawValue}'. Allowed values: auto, direct-http, mcp-sampling.`
  );
}

function resolveOptionalPlannerCredential(
  env: NodeJS.ProcessEnv,
  providerMode: PlannerProviderMode,
  transportMode: PlannerTransportMode
): { token?: string; source?: PlannerCredentialSource } {
  try {
    return resolvePlannerCredential(env, providerMode);
  } catch (error) {
    if (transportMode === "direct-http") {
      throw error;
    }
    return {};
  }
}

function resolveBridgePlannerClient(
  config: BridgeConfig,
  getServer?: () => McpServer | undefined
) {
  const transport = selectPlannerTransport(config, getServer?.());
  if (transport === "mcp-sampling") {
    const server = getServer?.();
    if (!server) {
      throw new Error("MCP sampling planner transport requires an active MCP server connection.");
    }
    return createMcpSamplingPlannerClient({
      host: server.server,
      modelHint: config.llmModel,
      profile: config.llmProfile ?? "full"
    });
  }

  if (!config.llmEndpoint || !config.llmModel || !config.llmToken) {
    throw new Error(
      "Direct planner transport requires TPF_LLM_ENDPOINT, TPF_LLM_MODEL, and a usable planner credential."
    );
  }

  return createOpenAiPlannerClient({
    endpoint: config.llmEndpoint,
    model: config.llmModel,
    token: config.llmToken,
    profile: config.llmProfile ?? "full",
    providerMode: config.llmProviderMode ?? "openai-compatible",
    fetchImpl: config.providerFetchImpl
  });
}

function selectPlannerTransport(
  config: BridgeConfig,
  server: McpServer | undefined
): Exclude<PlannerTransportMode, "auto"> {
  const mode = config.plannerTransportMode ?? "auto";
  const effectiveMode = mode === undefined ? "direct-http" : mode;
  const hasSampling = !!server?.server.getClientCapabilities()?.sampling;

  if (effectiveMode === "mcp-sampling") {
    if (!hasSampling) {
      throw new Error(
        "Experimental MCP planner transport mcp-sampling is not supported by the connected client."
      );
    }
    return "mcp-sampling";
  }

  if (effectiveMode === "auto") {
    return hasSampling ? "mcp-sampling" : "direct-http";
  }

  return "direct-http";
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function unsupportedAnalyzeBriefTool(_input: BriefInput): Promise<AnalyzeResult> {
  throw new Error(
    "The local TPF bridge only exposes the session workflow tools: " +
    "start_brief_session, answer_contract_questions, get_brief_session, and generate_scaffold."
  );
}

async function unsupportedScaffoldTool(_input: BriefInput): Promise<ScaffoldResult> {
  throw new Error(
    "The local TPF bridge only exposes the session workflow tools: " +
    "start_brief_session, answer_contract_questions, get_brief_session, and generate_scaffold."
  );
}

export type { TpfMcpHandlers };
