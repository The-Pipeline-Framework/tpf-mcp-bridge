import * as z from "zod/v4";
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
} from "@modelcontextprotocol/sdk/types.js";
import { analyzeBrief } from "./brief-analysis.js";
import type {
  ContractAnswerRecord,
  PlannerProfile,
  PlannerProviderMode,
  PlannerDraft,
  SessionStartInput
} from "./types.js";

export interface PlannerClient {
  planInitialBrief(input: SessionStartInput): Promise<PlannerDraft>;
  revisePlanWithAnswers(input: SessionStartInput, previousDraft: PlannerDraft | undefined, answers: Record<string, ContractAnswerRecord>): Promise<PlannerDraft>;
}

export interface OpenAiPlannerConfig {
  endpoint?: string;
  model?: string;
  token?: string;
  profile?: PlannerProfile;
  providerMode?: PlannerProviderMode;
  fetchImpl?: typeof fetch;
}

export interface McpSamplingPlannerHost {
  createMessage(
    params: CreateMessageRequest["params"]
  ): Promise<CreateMessageResult | CreateMessageResultWithTools>;
  getClientCapabilities(): ClientCapabilities | undefined;
}

export interface McpSamplingPlannerConfig {
  host: McpSamplingPlannerHost;
  modelHint?: string;
  profile?: PlannerProfile;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly providerStatus?: number
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

const questionSchema = z.object({
  id: z.string(),
  key: z.union([
    z.literal("stepContracts"),
    z.literal("basePackage"),
    z.literal("businessFlow"),
    z.literal("transport"),
    z.literal("platform"),
    z.literal("runtimeLayout"),
    z.literal("persistence"),
    z.literal("cache"),
    z.literal("cacheInvalidation"),
    z.literal("cacheInvalidationAll"),
    z.literal("asyncMode"),
    z.literal("outputDir")
  ]),
  prompt: z.string(),
  stepId: z.string().optional(),
  stepName: z.string().optional(),
  kind: z.enum(["fields", "type-name", "required-fields", "status-values"]).optional(),
  messageTypeName: z.string().optional(),
  expectedAnswerShape: z.object({
    type: z.enum(["fields", "string-list"]),
    description: z.string()
  }).optional(),
  proposedAnswer: z.object({
    questionId: z.string().optional(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().optional(),
      repeated: z.boolean().optional(),
      source: z.enum(["payload", "persisted_state", "derived"]).optional()
    })).optional(),
    values: z.array(z.string()).optional()
  }).optional(),
  resolutionModes: z.array(z.enum(["confirm", "replace", "edit"])).optional()
});

const contractQuestionSchema = z.object({
  id: z.string(),
  key: z.literal("stepContracts"),
  prompt: z.string(),
  stepId: z.string().optional(),
  stepName: z.string().optional(),
  kind: z.enum(["fields", "type-name", "required-fields", "status-values"]),
  messageTypeName: z.string(),
  expectedAnswerShape: z.object({
    type: z.enum(["fields", "string-list"]),
    description: z.string()
  }),
  proposedAnswer: z.object({
    questionId: z.string().optional(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().optional(),
      repeated: z.boolean().optional(),
      source: z.enum(["payload", "persisted_state", "derived"]).optional()
    })).optional(),
    values: z.array(z.string()).optional()
  }).optional(),
  resolutionModes: z.array(z.enum(["confirm", "replace", "edit"])).optional()
});

const messageFieldSchema = z.object({
  number: z.number().int(),
  name: z.string(),
  type: z.string(),
  keyType: z.string().optional(),
  valueType: z.string().optional(),
  repeated: z.boolean().optional(),
  optional: z.boolean().optional()
});

const awaitTransportSchema = z.object({
  type: z.enum(["interaction-api", "webhook", "kafka", "sqs"]),
  config: z.record(z.string(), z.unknown()).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  callback: z.record(z.string(), z.unknown()).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  consumer: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  dispatch: z.record(z.string(), z.unknown()).optional(),
  url: z.string().optional()
});

const awaitConfigSchema = z.object({
  dispatch: z.object({
    mode: z.enum(["single", "per-item"]).optional()
  }).optional(),
  correlation: z.object({
    strategy: z.enum(["interactionId", "signedResumeToken"])
  }),
  transport: awaitTransportSchema
});

const stepDraftCommonSchema = z.object({
  kind: z.enum(["internal", "delegated", "remote", "await"]).optional(),
  inputTypeName: z.string(),
  outputTypeName: z.string(),
  flowRole: z.enum(["forward", "query", "resume", "expansion", "reduction", "merge"]).optional(),
  flowBoundaryRationale: z.string().optional(),
  timeout: z.string().optional(),
  idempotencyKeyFields: z.array(z.string()).optional(),
  await: awaitConfigSchema.optional(),
  runOnVirtualThreads: z.boolean().optional()
});

const checkpointPublicationSchema = z.object({
  publication: z.string().trim().min(1),
  idempotencyKeyFields: z.array(z.string().trim().min(1)).optional()
});

const checkpointSubscriptionSchema = z.object({
  publication: z.string().trim().min(1),
  mapper: z.string().trim().min(1).optional()
});

const pipelineInputBoundarySchema = z.object({
  subscription: checkpointSubscriptionSchema.optional()
});

const pipelineOutputBoundarySchema = z.object({
  checkpoint: checkpointPublicationSchema.optional()
});

const compositionManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1),
  pipelines: z.array(z.object({
    id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
    path: z.string().trim().min(1).max(240)
  })).min(1)
});

const plannerDraftSchema = z.object({
  title: z.string(),
  primaryGoal: z.string(),
  outputArtifact: z.string().optional(),
  businessSteps: z.array(stepDraftCommonSchema.extend({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    inputFields: z.array(messageFieldSchema),
    outputFields: z.array(messageFieldSchema)
  })),
  pipelineSteps: z.array(stepDraftCommonSchema.extend({
    id: z.string().optional(),
    name: z.string(),
    cardinality: z.enum(["ONE_TO_ONE", "EXPANSION", "REDUCTION", "SIDE_EFFECT", "MANY_TO_MANY", "ONE_TO_MANY", "MANY_TO_ONE"]),
    parallel: z.boolean().optional(),
    batchSize: z.number().int().optional(),
    batchTimeoutMs: z.number().int().optional()
  })),
  messageCatalog: z.array(z.object({
    id: z.string().optional(),
    name: z.string(),
    fields: z.array(messageFieldSchema)
  })),
  stepContracts: z.array(stepDraftCommonSchema.extend({
    stepId: z.string(),
    stepName: z.string(),
    inputFields: z.array(messageFieldSchema),
    outputFields: z.array(messageFieldSchema),
    continuity: z.enum(["coherent", "clarification_needed"]),
    rationale: z.string()
  })),
  contractQuestions: z.array(contractQuestionSchema),
  futureStepCandidates: z.array(z.string()),
  assumptions: z.array(z.string()),
  questions: z.array(questionSchema.transform((question) => ({
    id: question.id,
    key: question.key,
    prompt: question.prompt,
    ...(question.stepId ? { stepId: question.stepId } : {}),
    ...(question.stepName ? { stepName: question.stepName } : {})
  }))).optional(),
  transport: z.enum(["GRPC", "REST", "LOCAL"]).optional(),
  platform: z.enum(["COMPUTE", "FUNCTION"]).optional(),
  runtimeLayout: z.enum(["MODULAR", "PIPELINE_RUNTIME", "MONOLITH"]).optional(),
  inputBoundary: pipelineInputBoundarySchema.optional(),
  outputBoundary: pipelineOutputBoundarySchema.optional(),
  compositionManifest: compositionManifestSchema.optional(),
  aspects: z.record(z.string(), z.object({
    enabled: z.boolean().optional(),
    scope: z.enum(["GLOBAL", "STEPS"]).optional(),
    position: z.enum(["BEFORE_STEP", "AFTER_STEP"]).optional(),
    order: z.number().int().optional(),
    config: z.record(z.string(), z.unknown()).optional()
  })).optional(),
  technicalConcerns: z.array(z.object({
    concern: z.enum([
      "validation",
      "persistence",
      "encryption",
      "state-transition",
      "cache",
      "replayability",
      "idempotency",
      "checkpoint-handoff"
    ]),
    appliesToSteps: z.array(z.string()),
    details: z.string()
  })).optional(),
  couplingFindings: z.array(z.object({
    id: z.string(),
    sourceStep: z.string(),
    targetStep: z.string(),
    fields: z.array(z.string()),
    severity: z.enum(["info", "warning"]),
    rationale: z.string()
  })).optional()
});

const plannerDraftJsonSchema = plannerDraftSchema.omit({ questions: true }).extend({
  questions: z.array(questionSchema).optional()
});

export function createOpenAiPlannerClient(config: OpenAiPlannerConfig): PlannerClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const profile = config.profile ?? "full";
  const providerMode = config.providerMode ?? "openai-compatible";

  return {
    async planInitialBrief(input) {
      return requestPlannerDraft(fetchImpl, config, buildPlanPrompt(input, profile), providerMode);
    },
    async revisePlanWithAnswers(input, previousDraft, answers) {
      return requestPlannerDraft(fetchImpl, config, buildRevisionPrompt(input, previousDraft, answers, profile), providerMode);
    }
  };
}

export function createMcpSamplingPlannerClient(config: McpSamplingPlannerConfig): PlannerClient {
  const profile = config.profile ?? "full";

  return {
    async planInitialBrief(input) {
      return requestSamplingPlannerDraft(config, buildPlanPrompt(input, profile), profile);
    },
    async revisePlanWithAnswers(input, previousDraft, answers) {
      return requestSamplingPlannerDraft(
        config,
        buildRevisionPrompt(input, previousDraft, answers, profile),
        profile
      );
    }
  };
}

export function createHeuristicPlannerClient(): PlannerClient {
  return {
    async planInitialBrief(input) {
      const analysis = await analyzeBrief(input, { contractAnswers: {} });
      return plannerDraftFromAnalysis(analysis);
    },
    async revisePlanWithAnswers(input, _previousDraft, answers) {
      const analysis = await analyzeBrief(input, { contractAnswers: answers });
      return plannerDraftFromAnalysis(analysis);
    }
  };
}

async function requestPlannerDraft(
  fetchImpl: typeof fetch,
  config: OpenAiPlannerConfig,
  prompt: PlannerPrompt,
  providerMode: PlannerProviderMode
): Promise<PlannerDraft> {
  if (!config.endpoint || !config.model || !config.token) {
    throw new PlannerError("Missing OpenAI-compatible planner configuration.", 400);
  }

  const response = await (providerMode === "ollama-native"
    ? fetchOllamaPlannerDraft(fetchImpl, config, prompt)
    : fetchOpenAiCompatiblePlannerDraft(fetchImpl, config, prompt)
  ).catch((error) => {
    if (error instanceof PlannerError) {
      throw error;
    }
    throw new PlannerError(`Planner request failed: ${error instanceof Error ? error.message : "unknown error"}`, 502);
  });

  if (!response.ok) {
    throw await createProviderPlannerError(response);
  }

  const payload = await response.json().catch(() => {
    throw new PlannerError("Planner provider returned non-JSON output.", 502);
  });

  const content = extractAssistantContent(payload);
  if (!content) {
    throw new PlannerError("Planner provider did not return assistant content.", 502);
  }

  return parsePlannerDraftContent(content);
}

async function requestSamplingPlannerDraft(
  config: McpSamplingPlannerConfig,
  prompt: PlannerPrompt,
  profile: PlannerProfile
): Promise<PlannerDraft> {
  if (!config.host.getClientCapabilities()?.sampling) {
    throw new PlannerError(
      "MCP client does not support sampling/createMessage. Configure direct planner credentials or use an MCP host with sampling support.",
      400
    );
  }

  const schema = z.toJSONSchema(plannerDraftJsonSchema, { target: "draft-07" });
  const response = await config.host.createMessage({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            prompt.userContent,
            "",
            "Return JSON matching this schema exactly:",
            JSON.stringify(schema)
          ].join("\n")
        }
      }
    ],
    systemPrompt: prompt.systemContent,
    maxTokens: profile === "compact" ? 4000 : 7000,
    modelPreferences: {
      ...(config.modelHint ? { hints: [{ name: config.modelHint }] } : {}),
      costPriority: 0.2,
      speedPriority: profile === "compact" ? 0.85 : 0.35,
      intelligencePriority: profile === "compact" ? 0.7 : 0.95
    }
  }).catch((error) => {
    throw new PlannerError(
      `MCP sampling request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      502
    );
  });

  const content = extractSamplingTextContent(response.content);
  if (!content) {
    throw new PlannerError("MCP sampling did not return text content.", 502);
  }

  return parsePlannerDraftContent(content);
}

async function fetchOpenAiCompatiblePlannerDraft(
  fetchImpl: typeof fetch,
  config: OpenAiPlannerConfig,
  prompt: PlannerPrompt
): Promise<Response> {
  if (!config.endpoint || !config.model || !config.token) {
    throw new PlannerError("Missing OpenAI-compatible planner configuration.", 400);
  }

  return fetchImpl(new URL("chat/completions", ensureTrailingSlash(config.endpoint)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt.systemContent },
        { role: "user", content: prompt.userContent }
      ]
    })
  });
}

async function fetchOllamaPlannerDraft(
  fetchImpl: typeof fetch,
  config: OpenAiPlannerConfig,
  prompt: PlannerPrompt
): Promise<Response> {
  if (!config.endpoint || !config.model) {
    throw new PlannerError("Missing Ollama planner endpoint or model configuration.", 400);
  }

  const format = z.toJSONSchema(plannerDraftJsonSchema, { target: "draft-07" });
  return fetchImpl(resolveOllamaChatUrl(config.endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token && shouldSendAuthorization(config.token)
        ? { authorization: `Bearer ${config.token}` }
        : {})
    },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      format,
      options: {
        temperature: 0.2
      },
      messages: [
        { role: "system", content: prompt.systemContent },
        {
          role: "user",
          content: [
            prompt.userContent,
            "",
            "Return JSON matching this schema exactly:",
            JSON.stringify(format)
          ].join("\n")
        }
      ]
    })
  });
}

async function createProviderPlannerError(response: Response): Promise<PlannerError> {
  const rawBody = await response.text();
  const details = parseProviderError(rawBody);
  const status = normalizePlannerProviderStatus(response.status);

  if (response.status === 401) {
    return new PlannerError(
      `Planner provider authentication failed (401${details.code ? ` ${details.code}` : ""}). Check the OpenAI-compatible API token.`,
      status,
      details.code,
      response.status
    );
  }

  if (response.status === 403) {
    return new PlannerError(
      `Planner provider rejected the request (403${details.code ? ` ${details.code}` : ""}). Check model access and provider permissions.`,
      status,
      details.code,
      response.status
    );
  }

  if (response.status === 429 && details.code === "insufficient_quota") {
    return new PlannerError(
      "Planner provider quota exceeded (429 insufficient_quota). The configured OpenAI-compatible API key has no available quota or billing capacity.",
      status,
      details.code,
      response.status
    );
  }

  if (response.status === 429) {
    return new PlannerError(
      `Planner provider rate limited (429${details.code ? ` ${details.code}` : ""})${details.message ? `: ${details.message}` : "."}`,
      status,
      details.code,
      response.status
    );
  }

  return new PlannerError(
    `Planner provider request failed (${response.status})${details.message ? `: ${details.message}` : "."}`,
    status,
    details.code,
    response.status
  );
}

function normalizePlannerProviderStatus(status: number): number {
  return status >= 400 && status < 500 ? status : 502;
}

function parseProviderError(rawBody: string): { code?: string; message?: string } {
  if (!rawBody.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { code?: unknown; type?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const errorObject = parsed.error;
    const code = typeof errorObject?.code === "string"
      ? errorObject.code
      : typeof errorObject?.type === "string"
        ? errorObject.type
        : typeof parsed.code === "string"
          ? parsed.code
          : undefined;
    const message = typeof errorObject?.message === "string"
      ? errorObject.message
      : typeof parsed.message === "string"
        ? parsed.message
        : undefined;
    return { code, message };
  } catch {
    return {
      message: truncateProviderMessage(rawBody)
    };
  }
}

function truncateProviderMessage(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function normalizePlannerDraft(draft: z.output<typeof plannerDraftSchema>): PlannerDraft {
  return {
    ...draft,
    messageCatalog: draft.messageCatalog.map((message) => ({
      ...message,
      id: message.id || `message.${message.name.toLowerCase()}`
    })),
    contractQuestions: draft.contractQuestions.map((question) => ({
      ...question,
      proposedAnswer: question.proposedAnswer
        ? {
            questionId: question.id,
            ...(question.proposedAnswer.fields ? { fields: question.proposedAnswer.fields } : {}),
            ...(question.proposedAnswer.values ? { values: question.proposedAnswer.values } : {})
          }
        : undefined
    }))
  };
}

function extractAssistantContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const ollamaMessageContent = (payload as { message?: { content?: unknown } }).message?.content;
  if (typeof ollamaMessageContent === "string") {
    return ollamaMessageContent;
  }
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean);
    return textParts.join("");
  }
  return undefined;
}

function extractSamplingTextContent(
  content: CreateMessageResult["content"] | CreateMessageResultWithTools["content"]
): string | undefined {
  const parts = Array.isArray(content) ? content : [content];
  const text = parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

function parsePlannerDraftContent(content: string): PlannerDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PlannerError("Planner provider returned invalid JSON content.", 502);
  }

  try {
    return normalizePlannerDraft(plannerDraftSchema.parse(parsed));
  } catch (error) {
    throw new PlannerError(
      `Planner provider returned an invalid draft: ${error instanceof Error ? error.message : "schema validation failed"}`,
      502
    );
  }
}

function plannerDraftFromAnalysis(analysis: Awaited<ReturnType<typeof analyzeBrief>>): PlannerDraft {
  return {
    title: analysis.pipelineSummary.title,
    primaryGoal: analysis.pipelineSummary.primaryGoal,
    outputArtifact: analysis.pipelineSummary.outputArtifact,
    businessSteps: analysis.businessSteps,
    pipelineSteps: analysis.inferredSteps,
    messageCatalog: analysis.messageCatalog,
    stepContracts: analysis.stepContracts,
    contractQuestions: analysis.contractQuestions.map((question) => ({
      ...question,
      resolutionModes: question.resolutionModes || ["replace", "edit"]
    })),
    futureStepCandidates: analysis.futureStepCandidates,
    assumptions: analysis.assumptions,
    questions: analysis.questions,
    transport: analysis.pipelineSummary.transport,
    platform: analysis.pipelineSummary.platform,
    runtimeLayout: analysis.pipelineSummary.runtimeLayout,
    aspects: analysis.aspects,
    technicalConcerns: analysis.technicalConcerns,
    couplingFindings: analysis.couplingFindings
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveOllamaChatUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  let normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath.endsWith("/v1")) {
    normalizedPath = normalizedPath.slice(0, -3);
  }
  url.pathname = normalizedPath || "/";
  const base = ensureTrailingSlash(url.toString());
  if (normalizedPath === "/api") {
    return new URL("chat", base);
  }
  return new URL("api/chat", base);
}

function shouldSendAuthorization(token: string): boolean {
  const normalized = token.trim();
  return normalized.length > 0 && normalized.toLowerCase() !== "ollama";
}

interface PlannerPrompt {
  systemContent: string;
  userContent: string;
}

function buildPlanPrompt(input: SessionStartInput, profile: PlannerProfile): PlannerPrompt {
  const compact = profile === "compact";
  return {
    systemContent: compact ? COMPACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT,
    userContent: compact
      ? [
          "Return a TPF planner draft as JSON only.",
          "Keep it compact. Prefer concrete contracts and proposal-first contractQuestions.",
          "Preserve core TPF guardrails: no persistence steps, forward adjacency, resume outside the main flow, await only for real suspend/resume external boundaries.",
          "If the brief implies await behavior, use kind \"await\" with timeout, idempotencyKeyFields, and await config.",
          "",
          "Brief:",
          input.briefText
        ].join("\n")
      : [
          "Produce a TPF planner draft as JSON only.",
          "Prefer proposing concrete contracts rather than asking users to define fields from scratch.",
          "When you need clarification, include contractQuestions with proposedAnswer and resolutionModes.",
          "In the main forward-processing pipeline, step N+1 input must equal step N output unless you explicitly classify the boundary as query, resume, expansion, reduction, or merge.",
          "Never create explicit save, persist, store, or commit business steps for persistence. Persistence belongs to aspects/plugins, not business flow steps.",
          "Model resume or re-entry as a separate query/resumption surface, not a normal forward pipeline step.",
          "Use await steps only when the brief implies a real suspend/resume external boundary. Distinguish await steps from checkpoint hand-off and from ordinary forward steps.",
          "For await steps, use kind \"await\" and provide timeout, idempotencyKeyFields, and await.transport / await.correlation details. Supported await transports are interaction-api, webhook, kafka, and sqs.",
          "Checkpoint handoff is not await: model it with outputBoundary.checkpoint and, for downstream pipeline ownership, inputBoundary.subscription or compositionManifest.",
          "Use caching as an aspect or optimization recommendation, not a default business step.",
          "Treat replayability, idempotency, and checkpoint hand-offs as technical concerns or optional follow-up questions when the brief implies them.",
          "Use TPF defaults only as recommendations: transport REST, platform COMPUTE, runtimeLayout MONOLITH unless the brief strongly suggests otherwise.",
          "Keep future stories out of the generated MVP pipeline and list them in futureStepCandidates.",
          "",
          "Brief:",
          input.briefText
        ].join("\n")
  };
}

function buildRevisionPrompt(
  input: SessionStartInput,
  previousDraft: PlannerDraft | undefined,
  answers: Record<string, ContractAnswerRecord>,
  profile: PlannerProfile
): PlannerPrompt {
  const compact = profile === "compact";
  return {
    systemContent: compact ? COMPACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT,
    userContent: compact
      ? [
          "Revise the TPF planner draft as JSON only.",
          "Apply the provided answers. Keep proposal-first questions only where still needed.",
          "Preserve core TPF guardrails: no persistence steps, forward adjacency, resume outside the main flow, await distinct from checkpoint hand-off.",
          "",
          "Brief:",
          input.briefText,
          "",
          "Previous draft:",
          JSON.stringify(previousDraft || null),
          "",
          "Resolved answers:",
          JSON.stringify(answers)
        ].join("\n")
      : [
          "Revise the TPF planner draft as JSON only.",
          "Apply the provided contract answers and keep the rest of the draft coherent.",
          "Preserve TPF semantics: no explicit persistence steps, resume stays separate from the main forward pipeline, and forward steps chain by adjacent output-to-input type unless a non-linear boundary is explicitly classified.",
          "If the brief implies caching, replayability, idempotency, or checkpoint hand-offs, express those as aspects, technical concerns, or focused operational questions rather than as generic business steps.",
          "If the brief implies a human approval, third-party callback, or brokered external decision before the pipeline can continue, model that boundary as kind \"await\" instead of a checkpoint note or fake save step. Use sqs for SQS-brokered await behavior.",
          "If ownership transfers to another pipeline after this one completes, model checkpoint handoff with outputBoundary.checkpoint and optional compositionManifest instead of await.",
          "If ambiguity remains, keep only the unresolved contractQuestions.",
          "",
          "Brief:",
          input.briefText,
          "",
          "Previous draft:",
          JSON.stringify(previousDraft || null, null, 2),
          "",
          "Resolved answers:",
          JSON.stringify(answers, null, 2)
        ].join("\n")
  };
}

const FULL_SYSTEM_PROMPT = `
You are the planning layer for The Pipeline Framework (TPF).
Return a single JSON object only. Do not wrap it in Markdown.

Your job is to transform a business brief into a structured draft for a TPF pipeline scaffold.
Rules:
- Prefer proposing concrete business steps and message contracts.
- Ask only focused contract questions that materially block a credible scaffold.
- For any contract question where you can infer a likely answer, include proposedAnswer.
- Keep question prompts short and operational.
- Keep future or non-MVP items out of the active pipeline and place them in futureStepCandidates.
- Use step ids and message names consistently across the draft.
- Keep message field names unique inside each message.
- Keep cardinality honest: EXPANSION for fan-out, REDUCTION for aggregate/writeout, ONE_TO_ONE otherwise.
- Treat persistence as an aspect/plugin concern. Do not emit save, persist, store, or commit business steps.
- In the main forward-processing pipeline, each step must consume the previous forward step's output type.
- If a step is not part of the forward-processing chain, classify it explicitly with flowRole as query, resume, expansion, reduction, or merge.
- Resume and re-entry belong to a separate query/resumption surface and must not appear as normal forward pipeline steps.
- Distinguish ordinary forward steps, await steps, and checkpoint hand-offs.
- Use kind "await" only for suspend/resume external boundaries inside one pipeline execution.
- Do not confuse checkpoint publication with await steps.
- Await steps must declare timeout, idempotencyKeyFields, and await config with correlation and transport details.
- Await transports in this slice are interaction-api, webhook, and kafka.
- Await steps are incompatible with FUNCTION pipelines.
- Use flowBoundaryRationale when a non-forward or non-adjacent boundary is intentional.
- Treat caching as a cross-cutting optimization concern, not a default business step.
- Treat replayability, idempotency, and checkpoint hand-offs as technical concerns, aspect recommendations, or focused clarification questions when the brief implies them.
- Keep businessSteps, pipelineSteps, stepContracts, and messageCatalog mutually coherent.
`.trim();

const COMPACT_SYSTEM_PROMPT = `
You are the TPF planning layer.
Return one JSON object only.

Rules:
- proposal-first contract questions only
- no explicit save/persist/store business steps
- forward steps chain by adjacent output-to-input type
- resume/query surfaces stay outside the main forward pipeline
- await is distinct from checkpoint hand-off
- use kind "await" only for real suspend/resume external boundaries
- await requires timeout, idempotencyKeyFields, await.correlation.strategy, and await.transport.type
- keep businessSteps, pipelineSteps, stepContracts, and messageCatalog coherent
- include advanced concerns only when the brief implies them
`.trim();
