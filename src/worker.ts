import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createTpfMcpServer } from "./mcp-server.js";
import { PlannerError, type PlannerClient } from "./planner-client.js";
import { BriefSessionService } from "./session-service.js";
import { KvQuotaStore, dailyQuotaKey, hashValue, type ArtifactBlob, type ArtifactStore, type KvLike, type QuotaStore, type SessionStore } from "./storage.js";
import type {
  AnalyzeResult,
  AnswerQuestionsInput,
  BriefInput,
  GenerateSessionInput,
  GetSessionInput,
  ScaffoldResult,
  SessionResult,
  SessionState
} from "./types.js";

const SESSION_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ARTIFACT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
const REQUESTS_PER_IP_PER_DAY = 50;
const GENERATIONS_PER_IP_PER_DAY = 10;
const GENERATIONS_PER_SESSION = 3;
const NOOP_PLANNER_CLIENT: PlannerClient = {
  async planInitialBrief() {
    throw new PlannerError("Planner is not available on the hosted backend. Use the local TPF bridge.", 410);
  },
  async revisePlanWithAnswers() {
    throw new PlannerError("Planner is not available on the hosted backend. Use the local TPF bridge.", 410);
  }
};

interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  getByName(name: string): DurableObjectStubLike;
}

interface R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: {
    contentType?: string;
  };
}

interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: Record<string, unknown>): Promise<void>;
  get(key: string): Promise<R2ObjectLike | null>;
}

export interface WorkerEnv {
  TPF_MCP_SESSIONS: DurableObjectNamespaceLike;
  TPF_MCP_SESSION_SNAPSHOTS: KvLike;
  TPF_MCP_QUOTAS: KvLike;
  TPF_MCP_ARTIFACTS: R2BucketLike;
  TPF_MCP_BASE_URL?: string;
  TPF_MCP_API_TOKEN?: string;
  TPF_MCP_ALLOWED_ORIGIN?: string;
}

interface StoredSessionPayload {
  session: SessionState;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env);
  }
};

export async function handleWorkerRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ status: "ok" });
  }
  if (url.pathname.startsWith("/artifacts/")) {
    return proxyArtifactRequest(request, env);
  }
  if (url.pathname.startsWith("/api/")) {
    return handleApiRequest(request, env);
  }
  if (url.pathname !== "/mcp") {
    return new Response("Not found", { status: 404 });
  }
  const authFailure = requireApiToken(request, env);
  if (authFailure) {
    return authFailure;
  }

  const quotaStore = new KvQuotaStore(env.TPF_MCP_QUOTAS);
  const sessionClient = new WorkerSessionClient(env);
  const clientIp = extractClientIp(request);
  const baseUrl = resolveBaseUrl(request, env);

  const server = createTpfMcpServer({
    analyzeBrief: async (_input: BriefInput): Promise<AnalyzeResult> => {
      await consumeRequestQuota(quotaStore, clientIp);
      throw new PlannerError("Hosted remote MCP planning is no longer supported. Use the local TPF bridge so the planner can run on your machine.", 410);
    },
    scaffoldFromBrief: async (_input: BriefInput): Promise<ScaffoldResult> => {
      await consumeRequestQuota(quotaStore, clientIp);
      throw new PlannerError("Hosted remote MCP planning is no longer supported. Use the local TPF bridge so the planner can run on your machine.", 410);
    },
    startBriefSession: async (_input) => {
      await consumeRequestQuota(quotaStore, clientIp);
      throw new PlannerError("Hosted remote MCP planning is no longer supported. Use the local TPF bridge so the planner can run on your machine.", 410);
    },
    answerContractQuestions: async (_input: AnswerQuestionsInput) => {
      await consumeRequestQuota(quotaStore, clientIp);
      throw new PlannerError("Hosted remote MCP planning is no longer supported. Use the local TPF bridge so the planner can run on your machine.", 410);
    },
    getBriefSession: async (input: GetSessionInput) => sessionClient.getSessionResult(input),
    generateScaffold: async (input: GenerateSessionInput) => {
      await consumeGenerationQuota(quotaStore, clientIp);
      return sessionClient.generateScaffold(input, baseUrl);
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function handleApiRequest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), request, env);
  }

  const authFailure = requireApiToken(request, env);
  if (authFailure) {
    return withCors(authFailure, request, env);
  }

  const url = new URL(request.url);
  const quotaStore = new KvQuotaStore(env.TPF_MCP_QUOTAS);
  const sessionClient = new WorkerSessionClient(env);
  const clientIp = extractClientIp(request);
  const baseUrl = resolveBaseUrl(request, env);

  try {
    if (url.pathname === "/api/session" && request.method === "POST") {
      await consumeRequestQuota(quotaStore, clientIp);
      const input = await request.json() as StoredSessionPayload;
      return withCors(json(await sessionClient.putSession(input.session)), request, env);
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return withCors(json({ error: "Missing sessionId." }, { status: 400 }), request, env);
      }
      const stored = await sessionClient.getSessionState(sessionId);
      if (!stored) {
        return withCors(json({ error: `Unknown session '${sessionId}'.` }, { status: 404 }), request, env);
      }
      return withCors(json({ session: stored }), request, env);
    }
    if (url.pathname === "/api/get-session" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return withCors(json({ error: "Missing sessionId." }, { status: 400 }), request, env);
      }
      return withCors(json(await sessionClient.getSessionResult({ sessionId })), request, env);
    }
    if (url.pathname === "/api/generate-scaffold" && request.method === "POST") {
      await consumeGenerationQuota(quotaStore, clientIp);
      const input = await request.json() as GenerateSessionInput;
      return withCors(json(await sessionClient.generateScaffold(input, baseUrl)), request, env);
    }
    if ((url.pathname === "/api/start-session" || url.pathname === "/api/answer-questions") && request.method === "POST") {
      return withCors(json({
        error: "Hosted planner execution has been removed. Use the local TPF bridge, which now runs the planner on your machine."
      }, { status: 410 }), request, env);
    }
    return withCors(json({ error: "Not found." }, { status: 404 }), request, env);
  } catch (error) {
    return withCors(json({
      error: error instanceof Error ? error.message : "Unexpected error."
    }, { status: httpStatusForError(error) }), request, env);
  }
}

async function proxyArtifactRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const [, , sessionId] = url.pathname.split("/");
  if (!sessionId) {
    return new Response("Not found", { status: 404 });
  }
  const stub = env.TPF_MCP_SESSIONS.getByName(sessionId);
  return stub.fetch(request);
}

async function consumeRequestQuota(quotaStore: QuotaStore, clientIp: string): Promise<void> {
  const key = dailyQuotaKey("requests", clientIp);
  const result = await quotaStore.consume(key, REQUESTS_PER_IP_PER_DAY, 24 * 60 * 60);
  if (!result.allowed) {
    throw new Error(`Anonymous usage cap reached for request operations (${REQUESTS_PER_IP_PER_DAY}/day).`);
  }
}

async function consumeGenerationQuota(quotaStore: QuotaStore, clientIp: string): Promise<void> {
  const key = dailyQuotaKey("generations", clientIp);
  const result = await quotaStore.consume(key, GENERATIONS_PER_IP_PER_DAY, 24 * 60 * 60);
  if (!result.allowed) {
    throw new Error(`Anonymous usage cap reached for scaffold generations (${GENERATIONS_PER_IP_PER_DAY}/day).`);
  }
}

function extractClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function resolveBaseUrl(request: Request, env: WorkerEnv): string {
  return env.TPF_MCP_BASE_URL || `${new URL(request.url).origin}`;
}

function requireApiToken(request: Request, env: WorkerEnv): Response | null {
  const configuredToken = env.TPF_MCP_API_TOKEN?.trim();
  if (!configuredToken) {
    return null;
  }
  const header = request.headers.get("authorization");
  const expected = `Bearer ${configuredToken}`;
  if (header === expected) {
    return null;
  }
  return json({ error: "Unauthorized." }, {
    status: 401,
    headers: {
      "www-authenticate": "Bearer"
    }
  });
}

function withCors(response: Response, request: Request, env: WorkerEnv): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-max-age", "86400");
  headers.set("vary", "origin");

  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = env.TPF_MCP_ALLOWED_ORIGIN?.trim();
  if (allowedOrigin) {
    if (requestOrigin === allowedOrigin) {
      headers.set("access-control-allow-origin", allowedOrigin);
    }
  } else {
    headers.set("access-control-allow-origin", requestOrigin || "*");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function httpStatusForError(error: unknown): number {
  if (error instanceof PlannerError) {
    return error.status;
  }
  if (
    typeof error === "object"
    && error !== null
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unknown session")) {
    return 404;
  }
  if (message.includes("usage cap") || message.includes("generation cap")) {
    return 429;
  }
  if (message.includes("Missing") || message.includes("requires") || message.includes("Unknown or no-longer-active")) {
    return 400;
  }
  return 500;
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {})
    }
  });
}

class WorkerSessionClient {
  constructor(private readonly env: WorkerEnv) {}

  async putSession(session: SessionState): Promise<StoredSessionPayload> {
    const stub = this.env.TPF_MCP_SESSIONS.getByName(session.sessionId);
    return this.fetchJson<StoredSessionPayload>(stub, "https://session.internal/session", {
      method: "POST",
      body: JSON.stringify({ session })
    });
  }

  async getSessionState(sessionId: string): Promise<SessionState | undefined> {
    const stub = this.env.TPF_MCP_SESSIONS.getByName(sessionId);
    const response = await stub.fetch(`https://session.internal/session?sessionId=${encodeURIComponent(sessionId)}`);
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const payload = await response.json() as StoredSessionPayload;
    return payload.session;
  }

  async getSessionResult(input: GetSessionInput): Promise<SessionResult> {
    const stub = this.env.TPF_MCP_SESSIONS.getByName(input.sessionId);
    return this.fetchJson<SessionResult>(stub, `https://session.internal/session-result?sessionId=${encodeURIComponent(input.sessionId)}`);
  }

  async generateScaffold(input: GenerateSessionInput, baseUrl: string): Promise<SessionResult> {
    const stub = this.env.TPF_MCP_SESSIONS.getByName(input.sessionId);
    return this.fetchJson<SessionResult>(stub, "https://session.internal/generate", {
      method: "POST",
      body: JSON.stringify({ ...input, baseUrl })
    });
  }

  private async fetchJson<T>(stub: DurableObjectStubLike, input: RequestInfo | URL, init?: RequestInit): Promise<T> {
    const response = await stub.fetch(input, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers || {})
      }
    });
    if (!response.ok) {
      const payload = await response.json().catch(async () => ({
        error: await response.text()
      }));
      const message = typeof payload?.error === "string"
        ? payload.error
        : `Hosted TPF session request failed (${response.status}).`;
      if (response.status >= 400 && response.status < 500) {
        throw new PlannerError(message, response.status);
      }
      throw new Error(message);
    }
    return response.json() as Promise<T>;
  }
}

export class BriefSessionDurableObject {
  constructor(private readonly state: DurableObjectStateLike, private readonly env: WorkerEnv) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/session" && request.method === "POST") {
        return this.handleUpsert(request);
      }
      if (url.pathname === "/session" && request.method === "GET") {
        return this.handleSessionState(url);
      }
      if (url.pathname === "/session-result" && request.method === "GET") {
        return this.handleSessionResult(url);
      }
      if (url.pathname === "/generate" && request.method === "POST") {
        return this.handleGenerate(request);
      }
      if (url.pathname.startsWith("/artifacts/")) {
        return this.handleArtifactDownload(request, url);
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unexpected error." }, { status: httpStatusForError(error) });
    }
  }

  private async handleUpsert(request: Request): Promise<Response> {
    const payload = await request.json() as StoredSessionPayload;
    const store = this.createSessionStore();
    await store.put(payload.session);
    return json({ session: payload.session });
  }

  private async handleSessionState(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }
    const store = this.createSessionStore();
    const session = await store.get(sessionId);
    if (!session) {
      return new Response(`Unknown session '${sessionId}'.`, { status: 404 });
    }
    return json({ session });
  }

  private async handleSessionResult(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      return new Response("Missing sessionId", { status: 400 });
    }
    const service = this.createService();
    return json(await service.getSession({ sessionId }));
  }

  private async handleGenerate(request: Request): Promise<Response> {
    const payload = await request.json() as GenerateSessionInput & { baseUrl: string };
    const service = this.createService(payload.baseUrl);
    return json(await service.generateScaffold({ sessionId: payload.sessionId }, {
      artifactBaseUrl: payload.baseUrl,
      artifactTtlSeconds: ARTIFACT_TTL_SECONDS
    }));
  }

  private async handleArtifactDownload(_request: Request, url: URL): Promise<Response> {
    const parts = url.pathname.split("/");
    const sessionId = parts[2];
    const artifactId = parts[3];
    if (!sessionId || !artifactId) {
      return new Response("Not found", { status: 404 });
    }

    const sessionStore = this.createSessionStore();
    const session = await sessionStore.get(sessionId);
    if (!session?.lastArtifact) {
      return new Response("Artifact not found", { status: 404 });
    }
    const token = url.searchParams.get("token");
    const expectedUrl = session.lastArtifact.downloadUrl ? new URL(session.lastArtifact.downloadUrl) : null;
    const expectedToken = expectedUrl?.searchParams.get("token");
    if (!token || token !== expectedToken || artifactId !== session.lastArtifact.artifactId) {
      return new Response("Forbidden", { status: 403 });
    }
    if (new Date(session.lastArtifact.expiresAt).getTime() < Date.now()) {
      return new Response("Artifact expired", { status: 410 });
    }
    const artifactStore = this.createArtifactStore();
    const blob = await artifactStore.get(sessionId, artifactId);
    if (!blob) {
      return new Response("Artifact not found", { status: 404 });
    }
    const responseBytes = new Uint8Array(blob.bytes.length);
    responseBytes.set(blob.bytes);
    return new Response(new Blob([responseBytes.buffer], { type: blob.contentType }), {
      headers: {
        "content-type": blob.contentType,
        "content-disposition": `attachment; filename="${artifactId}.zip"`
      }
    });
  }

  private createService(baseUrl?: string): BriefSessionService {
    return new BriefSessionService(
      this.createSessionStore(),
      this.createArtifactStore(baseUrl),
      NOOP_PLANNER_CLIENT,
      { maxGenerationsPerSession: GENERATIONS_PER_SESSION }
    );
  }

  private createSessionStore(): SessionStore {
    const state = this.state;
    const snapshots = this.env.TPF_MCP_SESSION_SNAPSHOTS;
    return {
      async get(sessionId: string): Promise<SessionState | undefined> {
        const fromState = await state.storage.get<SessionState>("session");
        if (fromState?.sessionId === sessionId) {
          return fromState;
        }
        const fromSnapshot = await snapshots.get(snapshotKey(sessionId));
        if (!fromSnapshot) {
          return undefined;
        }
        const parsed = JSON.parse(fromSnapshot) as SessionState;
        await state.storage.put("session", parsed);
        return parsed;
      },
      async put(session: SessionState): Promise<void> {
        await state.storage.put("session", session);
        await snapshots.put(snapshotKey(session.sessionId), JSON.stringify(session), {
          expirationTtl: SESSION_SNAPSHOT_TTL_SECONDS
        });
      }
    };
  }

  private createArtifactStore(baseUrl?: string): ArtifactStore {
    const bucket = this.env.TPF_MCP_ARTIFACTS;
    return {
      async put(sessionId: string, bytes: Uint8Array, options: { ttlSeconds?: number; baseUrl?: string } = {}) {
        const artifactId = crypto.randomUUID();
        const objectKey = artifactKey(sessionId, artifactId);
        await bucket.put(objectKey, bytes, {
          httpMetadata: {
            contentType: "application/zip"
          }
        });
        const token = `${artifactId}.${hashValue(`${sessionId}:${artifactId}:${Date.now()}`)}`;
        const artifactBaseUrl = options.baseUrl || baseUrl;
        return {
          artifactId,
          contentType: "application/zip",
          objectKey,
          expiresAt: new Date(Date.now() + DEFAULT_SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
          ...(artifactBaseUrl ? { downloadUrl: `${artifactBaseUrl}/artifacts/${sessionId}/${artifactId}?token=${encodeURIComponent(token)}` } : {})
        };
      },
      async get(sessionId: string, artifactId: string): Promise<ArtifactBlob | undefined> {
        const object = await bucket.get(artifactKey(sessionId, artifactId));
        if (!object) {
          return undefined;
        }
        return {
          bytes: new Uint8Array(await object.arrayBuffer()),
          contentType: object.httpMetadata?.contentType || "application/zip"
        };
      }
    };
  }
}

function artifactKey(sessionId: string, artifactId: string): string {
  return `artifacts/${sessionId}/${artifactId}.zip`;
}

function snapshotKey(sessionId: string): string {
  return `session:${sessionId}`;
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

export class InMemoryKv implements KvLike {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

export class InMemoryR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: Record<string, unknown>): Promise<void> {
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, {
      bytes,
      contentType: (options?.httpMetadata as { contentType?: string } | undefined)?.contentType || "application/octet-stream"
    });
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return {
      arrayBuffer: async () => object.bytes.slice().buffer,
      httpMetadata: {
        contentType: object.contentType
      }
    };
  }
}
