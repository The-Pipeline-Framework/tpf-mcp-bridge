import { spawn } from "node:child_process";
import * as z from "zod/v4";
import type {
  ClientCapabilities,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
} from "@modelcontextprotocol/sdk/types.js";
import { analyzeBrief } from "./brief-analysis.js";
import type {
  CommandDuplicatePolicy,
  ContractAnswerRecord,
  MessageCatalogEntry,
  MessageField,
  PlannerProfile,
  PlannerProviderMode,
  PlannerDraft,
  SessionStartInput,
  StepCardinality,
  StepKind,
  UnionDefinition
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
  workingDirectory?: string;
  cliTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
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

const queryCaptureSchema = z.object({
  keyFields: z.array(z.string().trim().min(1)).optional()
});

const commandDuplicatePolicySchema = z.string()
  .trim()
  .regex(/^(RETURN_RECORDED|FAIL)$/i);

const jpaQualifiedIdentifierSchema = z.string()
  .trim()
  .min(1)
  .regex(/^[A-Za-z_$][A-Za-z\d_$]*(\.[A-Za-z_$][A-Za-z\d_$]*)*$/);

const jpaPredicateScalarSchema = z.union([
  z.string().trim().min(1),
  z.number(),
  z.boolean()
]);

const jpaPredicateExpressionSchema = z.object({
  eq: jpaPredicateScalarSchema.optional(),
  in: z.union([
    jpaPredicateScalarSchema,
    z.array(jpaPredicateScalarSchema).min(1)
  ]).optional(),
  gt: jpaPredicateScalarSchema.optional(),
  gte: jpaPredicateScalarSchema.optional(),
  lt: jpaPredicateScalarSchema.optional(),
  lte: jpaPredicateScalarSchema.optional(),
  between: z.tuple([jpaPredicateScalarSchema, jpaPredicateScalarSchema]).optional(),
  like: jpaPredicateScalarSchema.optional(),
  isNull: z.union([
    z.boolean(),
    z.string().trim().regex(/^([Tt][Rr][Uu][Ee]|[Ff][Aa][Ll][Ss][Ee])$/)
  ]).optional()
}).strict().refine(
  (value) => Object.values(value).filter((entry) => entry !== undefined).length === 1,
  { message: "JPA predicate objects must declare exactly one operator." }
);

const jpaWhereBindingSchema = z.union([
  z.string().trim().min(1),
  jpaPredicateExpressionSchema
]);

const jpaQueryDefinitionSchema = z.object({
  entity: z.string().trim().min(1),
  where: z.record(
    jpaQualifiedIdentifierSchema,
    jpaWhereBindingSchema
  ).refine((value) => Object.keys(value).length > 0, {
    message: "JPA query definitions must include at least one where predicate."
  }),
  projection: z.record(jpaQualifiedIdentifierSchema, jpaQualifiedIdentifierSchema).optional(),
  orderBy: z.record(
    jpaQualifiedIdentifierSchema,
    z.string().trim().regex(/^([Aa][Ss][Cc]|[Dd][Ee][Ss][Cc])$/)
  ).refine((value) => Object.keys(value).length > 0, {
    message: "JPA orderBy must include at least one field."
  }).optional(),
  limit: z.literal(1).optional(),
  result: z.literal("single").optional()
}).refine((value) => value.limit === undefined || value.orderBy !== undefined, {
  message: "JPA limit requires orderBy."
});

const queryDefinitionSchema = z.object({
  connector: z.literal("jpa"),
  input: z.string().trim().min(1).optional(),
  inputType: z.string().trim().min(1).optional(),
  output: z.string().trim().min(1).optional(),
  outputType: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  jpa: jpaQueryDefinitionSchema
}).refine((value) => Boolean(value.input || value.inputType), {
  message: "Query definitions must include input or inputType."
}).refine((value) => Boolean(value.output || value.outputType), {
  message: "Query definitions must include output or outputType."
});

const objectInputEmitSchema = z.object({
  type: z.string().trim().min(1),
  typeName: z.string().trim().min(1).optional(),
  mapper: z.string().trim().min(1)
});

const objectInputBoundarySchema = z.object({
  source: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  emits: objectInputEmitSchema
}).refine((value) => Boolean(value.source || value.from), {
  message: "Object input boundaries must include source or from."
});

const objectSourceSchema = z.object({
  kind: z.literal("object"),
  provider: z.enum(["filesystem", "s3"]),
  location: z.record(z.string().trim().min(1), z.unknown()).optional(),
  filter: z.object({
    include: z.array(z.string().trim().min(1)).optional(),
    exclude: z.array(z.string().trim().min(1)).optional()
  }).optional(),
  poll: z.object({
    enabled: z.boolean().optional(),
    interval: z.string().trim().min(1).optional(),
    batchSize: z.number().int().positive().optional()
  }).optional(),
  identity: z.object({
    fields: z.array(z.string().trim().min(1)).optional()
  }).optional(),
  payload: z.object({
    mode: z.enum(["metadata", "reference", "text"]).optional(),
    refField: z.string().trim().min(1).optional(),
    maxBytes: z.number().int().nonnegative().optional(),
    charset: z.string().trim().min(1).optional()
  }).optional()
});

const stepDraftCommonSchema = z.object({
  kind: z.enum(["internal", "delegated", "remote", "await", "query", "command"]).optional(),
  inputTypeName: z.string(),
  outputTypeName: z.string(),
  accepts: z.array(z.string().trim().min(1)).optional(),
  terminal: z.boolean().optional(),
  query: z.string().optional(),
  capture: queryCaptureSchema.optional(),
  command: z.string().optional(),
  commandIdGenerator: z.string().optional(),
  duplicatePolicy: commandDuplicatePolicySchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
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
  subscription: checkpointSubscriptionSchema.optional(),
  object: objectInputBoundarySchema.optional(),
  from: z.string().trim().min(1).optional(),
  emits: objectInputEmitSchema.optional()
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

const plannerUnionVariantSchema = z.object({
  number: z.number().int().positive(),
  type: z.string().trim().min(1),
  name: z.string().trim().min(1).optional()
});

const plannerUnionDefinitionSchema = z.object({
  variants: z.record(z.string().trim().min(1), plannerUnionVariantSchema)
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
  unions: z.record(z.string().trim().min(1), plannerUnionDefinitionSchema).optional(),
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
  queries: z.record(z.string().trim().min(1), queryDefinitionSchema).optional(),
  sources: z.record(z.string().trim().min(1), objectSourceSchema).optional(),
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

const semanticIntentMessageFieldSchema = z.object({
  name: z.string(),
  type: z.string()
});

const semanticIntentStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  input: z.string(),
  output: z.string(),
  accepts: z.array(z.string()).optional(),
  terminal: z.boolean().optional(),
  cardinality: z.enum(["ONE_TO_ONE", "EXPANSION", "REDUCTION", "SIDE_EFFECT"]),
  kind: z.enum(["internal", "query", "command", "await"])
});

const semanticIntentUnionSchema = z.object({
  name: z.string(),
  variants: z.array(z.object({
    name: z.string(),
    type: z.string(),
    number: z.number().int().positive().optional()
  })).min(1)
});

const semanticIntentSchema = z.object({
  title: z.string(),
  primaryGoal: z.string(),
  steps: z.array(semanticIntentStepSchema),
  unions: z.array(semanticIntentUnionSchema).optional(),
  messages: z.array(z.object({
    name: z.string(),
    fields: z.array(semanticIntentMessageFieldSchema)
  })),
  assumptions: z.array(z.string()),
  questions: z.array(z.string())
});

type SemanticIntentDraft = z.output<typeof semanticIntentSchema>;
type LocalCliPlannerProviderMode = Extract<PlannerProviderMode, "codex_cli" | "opencode">;

const DEFAULT_CLI_PLANNER_TIMEOUT_MS = 600_000;
const OPENCODE_READONLY_CONFIG = JSON.stringify({
  permission: Object.fromEntries(
    ["edit", "bash", "webfetch", "websearch", "external_directory", "doom_loop", "task"]
      .map((key) => [key, "deny"])
  )
});

function buildMockSemanticIntentDraft(input: SessionStartInput): SemanticIntentDraft {
  return {
    title: input.appName || "Mock Boundary Scaffold",
    primaryGoal: "Exercise command, await, validation, and state-plus-submission envelope compilation without calling an external LLM provider.",
    steps: [
      {
        id: "validate-initial-command",
        name: "Validate Initial Command",
        purpose: "Validate the initial command before creating aggregate state.",
        input: "InitialCommand",
        output: "ValidatedCommand",
        cardinality: "ONE_TO_ONE",
        kind: "internal"
      },
      {
        id: "execute-state-command",
        name: "Execute State Command",
        purpose: "Create or update aggregate state through a replay-safe command boundary.",
        input: "ValidatedCommand",
        output: "AggregateState",
        cardinality: "SIDE_EFFECT",
        kind: "command"
      },
      {
        id: "await-external-submission",
        name: "Await External Submission",
        purpose: "Collect an external submission through an interaction-api await boundary.",
        input: "AggregateState",
        output: "ExternalSubmission",
        cardinality: "SIDE_EFFECT",
        kind: "await"
      },
      {
        id: "validate-external-submission",
        name: "Validate External Submission",
        purpose: "Validate the external submission and return the updated aggregate state.",
        input: "ExternalSubmission",
        output: "AggregateState",
        cardinality: "ONE_TO_ONE",
        kind: "internal"
      },
      {
        id: "return-current-status",
        name: "Return Current Status",
        purpose: "Return the current aggregate status for the invocation.",
        input: "AggregateState",
        output: "FinalOutput",
        cardinality: "ONE_TO_ONE",
        kind: "internal"
      }
    ],
    messages: [
      {
        name: "InitialCommand",
        fields: [
          { name: "requestId", type: "uuid" },
          { name: "subjectId", type: "uuid" },
          { name: "payload", type: "string" }
        ]
      },
      {
        name: "ValidatedCommand",
        fields: [
          { name: "requestId", type: "uuid" },
          { name: "subjectId", type: "uuid" },
          { name: "accepted", type: "bool" }
        ]
      },
      {
        name: "AggregateState",
        fields: [
          { name: "aggregateId", type: "uuid" },
          { name: "status", type: "string" },
          { name: "version", type: "int64" }
        ]
      },
      {
        name: "ExternalSubmission",
        fields: [
          { name: "submissionId", type: "uuid" },
          { name: "payload", type: "string" }
        ]
      },
      {
        name: "FinalOutput",
        fields: [
          { name: "aggregateId", type: "uuid" },
          { name: "status", type: "string" },
          { name: "nextAction", type: "string" }
        ]
      }
    ],
    assumptions: [
      "Mock provider output is deterministic and intended for local CLI/workflow testing only."
    ],
    questions: []
  };
}

export function createOpenAiPlannerClient(config: OpenAiPlannerConfig): PlannerClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const profile = config.profile ?? "full";
  const providerMode = config.providerMode ?? "openai-compatible";

  return {
    async planInitialBrief(input) {
      if (providerMode === "mock") {
        return compileSemanticIntentDraftToPlannerDraft(buildMockSemanticIntentDraft(input));
      }
      if (providerMode === "ollama-native") {
        return requestOllamaSemanticIntentDraft(
          fetchImpl,
          config,
          buildOllamaSemanticIntentPrompt(input, profile)
        );
      }
      if (isLocalCliPlannerProviderMode(providerMode)) {
        return requestLocalCliSemanticIntentDraft(
          config,
          providerMode,
          buildOllamaSemanticIntentPrompt(input, profile)
        );
      }
      return requestPlannerDraft(fetchImpl, config, buildPlanPrompt(input, profile), providerMode);
    },
    async revisePlanWithAnswers(input, previousDraft, answers) {
      if (providerMode === "mock") {
        return previousDraft
          ? applyContractAnswersToPlannerDraft(previousDraft, answers)
          : compileSemanticIntentDraftToPlannerDraft(buildMockSemanticIntentDraft(input));
      }
      if (providerMode === "ollama-native") {
        if (previousDraft) {
          return applyContractAnswersToPlannerDraft(previousDraft, answers);
        }
        return requestOllamaSemanticIntentDraft(fetchImpl, config, buildOllamaSemanticIntentPrompt(input, profile));
      }
      if (isLocalCliPlannerProviderMode(providerMode)) {
        if (previousDraft) {
          return applyContractAnswersToPlannerDraft(previousDraft, answers);
        }
        return requestLocalCliSemanticIntentDraft(config, providerMode, buildOllamaSemanticIntentPrompt(input, profile));
      }
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

  const response = await fetchOpenAiCompatiblePlannerDraft(fetchImpl, config, prompt).catch((error) => {
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

  try {
    return parsePlannerDraftContent(content);
  } catch (error) {
    throw error;
  }
}

async function requestOllamaSemanticIntentDraft(
  fetchImpl: typeof fetch,
  config: OpenAiPlannerConfig,
  prompt: PlannerPrompt
): Promise<PlannerDraft> {
  const content = await requestOllamaPlannerContent(fetchImpl, config, prompt);
  const semanticIntent = parseSemanticIntentContent(content, { allowEmbeddedJson: true });
  return compileSemanticIntentDraftToPlannerDraft(semanticIntent);
}

async function requestOllamaPlannerContent(
  fetchImpl: typeof fetch,
  config: OpenAiPlannerConfig,
  prompt: PlannerPrompt
): Promise<string> {
  const response = await fetchOllamaPlannerDraft(fetchImpl, config, prompt).catch((error) => {
    if (error instanceof PlannerError) {
      throw error;
    }
    throw new PlannerError(`Planner request failed: ${error instanceof Error ? error.message : "unknown error"}`, 502);
  });

  if (!response.ok) {
    throw await createProviderPlannerError(response);
  }

  const rawBody = await response.text().catch(() => {
    throw new PlannerError("Planner provider returned non-text output.", 502);
  });

  const content = extractOllamaStreamContent(rawBody);
  if (!content) {
    throw new PlannerError("Planner provider did not return assistant content.", 502);
  }
  return content;
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

async function requestLocalCliPlannerDraft(
  config: OpenAiPlannerConfig,
  providerMode: LocalCliPlannerProviderMode,
  prompt: PlannerPrompt
): Promise<PlannerDraft> {
  const content = await requestLocalCliPlannerContent(config, providerMode, prompt);
  return parsePlannerDraftContent(content, { allowEmbeddedJson: true });
}

async function requestLocalCliSemanticIntentDraft(
  config: OpenAiPlannerConfig,
  providerMode: LocalCliPlannerProviderMode,
  prompt: PlannerPrompt
): Promise<PlannerDraft> {
  const content = await requestLocalCliPlannerContent(config, providerMode, prompt);
  const semanticIntent = parseSemanticIntentContent(content, { allowEmbeddedJson: true });
  return compileSemanticIntentDraftToPlannerDraft(semanticIntent);
}

async function requestLocalCliPlannerContent(
  config: OpenAiPlannerConfig,
  providerMode: LocalCliPlannerProviderMode,
  prompt: PlannerPrompt
): Promise<string> {
  const command = await buildLocalCliPlannerCommand(config, providerMode);
  const result = await runLocalCliPlannerCommand(command, combinePlannerPrompt(prompt), {
    cwd: config.workingDirectory ?? process.cwd(),
    timeoutMs: config.cliTimeoutMs ?? DEFAULT_CLI_PLANNER_TIMEOUT_MS,
    env: providerMode === "opencode"
      ? { ...(config.environment ?? process.env), OPENCODE_CONFIG_CONTENT: OPENCODE_READONLY_CONFIG }
      : config.environment ?? process.env
  });
  if (result.exitCode !== 0) {
    throw new PlannerError(
      `${providerMode} failed with exit code ${result.exitCode}.${result.stderr ? ` ${truncateProviderMessage(result.stderr)}` : ""}`,
      502,
      undefined,
      result.exitCode
    );
  }
  const content = providerMode === "codex_cli"
    ? extractCodexCliJsonlContent(result.stdout)
    : extractOpenCodeJsonContent(result.stdout);
  if (!content) {
    throw new PlannerError(
      `${providerMode} completed but did not return planner content.${result.stderr ? ` ${truncateProviderMessage(result.stderr)}` : ""}`,
      502,
      undefined,
      result.exitCode || undefined
    );
  }
  return content;
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
      stream: true,
      options: {
        temperature: 0.2,
        num_predict: 4096
      },
      messages: [
        { role: "system", content: prompt.systemContent },
        { role: "user", content: prompt.userContent }
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

function isLocalCliPlannerProviderMode(providerMode: PlannerProviderMode): providerMode is LocalCliPlannerProviderMode {
  return providerMode === "codex_cli" || providerMode === "opencode";
}

async function buildLocalCliPlannerCommand(
  config: OpenAiPlannerConfig,
  providerMode: LocalCliPlannerProviderMode
): Promise<{ executable: string; args: string[]; cleanup?: () => Promise<void> }> {
  const workdir = config.workingDirectory ?? process.cwd();
  const model = normalizeLocalCliModel(providerMode, config.model);
  if (providerMode === "opencode") {
    return {
      executable: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--dir",
        workdir,
        ...(model ? ["--model", model] : [])
      ]
    };
  }

  return {
    executable: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--json",
      "--cd",
      workdir,
      ...(model ? ["--model", model] : []),
      "-"
    ]
  };
}

function normalizeLocalCliModel(
  providerMode: LocalCliPlannerProviderMode,
  model: string | undefined
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (providerMode === "codex_cli") {
    if (trimmed === "codex_cli/default") {
      return undefined;
    }
    return trimmed.startsWith("codex_cli/") ? trimmed.slice("codex_cli/".length) || undefined : trimmed;
  }
  if (trimmed === "opencode/default") {
    return undefined;
  }
  return trimmed.startsWith("opencode/") ? trimmed.slice("opencode/".length) || undefined : trimmed;
}

async function runLocalCliPlannerCommand(
  command: { executable: string; args: string[]; cleanup?: () => Promise<void> },
  stdinText: string,
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        reject(new PlannerError(
          `${command.executable} timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`,
          502
        ));
      }, options.timeoutMs);

      child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
      child.on("error", () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new PlannerError(
          `${command.executable} is not available. Install and authenticate it before using this provider.`,
          400
        ));
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      child.stdin.end(stdinText, "utf8");
    });
  } finally {
    await command.cleanup?.();
  }
}

function combinePlannerPrompt(prompt: PlannerPrompt): string {
  return [
    "Follow these system instructions for this one-shot TPF planning task:",
    "",
    prompt.systemContent.trim(),
    "",
    "User request and context:",
    "",
    prompt.userContent.trim()
  ].join("\n");
}

function extractCodexCliJsonlContent(stdout: string): string | undefined {
  const parts: string[] = [];
  for (const event of parseJsonLines(stdout)) {
    if (event.type !== "item.completed" || !event.item || typeof event.item !== "object") {
      continue;
    }
    const item = event.item as { type?: unknown; text?: unknown };
    if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim() || undefined;
}

function extractOpenCodeJsonContent(stdout: string): string | undefined {
  const parts: string[] = [];
  for (const event of parseJsonLines(stdout)) {
    if (event.type !== "text" || !event.part || typeof event.part !== "object") {
      continue;
    }
    const text = (event.part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim() || undefined;
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
    }
  }
  return events;
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
    businessSteps: draft.businessSteps.map(normalizeParsedStepDraft),
    pipelineSteps: draft.pipelineSteps.map(normalizeParsedStepDraft),
    stepContracts: draft.stepContracts.map(normalizeParsedStepDraft),
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

function normalizeParsedStepDraft<T extends { duplicatePolicy?: string }>(
  step: T
): Omit<T, "duplicatePolicy"> & { duplicatePolicy?: CommandDuplicatePolicy } {
  const duplicatePolicy = step.duplicatePolicy?.trim().toUpperCase();
  return {
    ...step,
    ...("accepts" in step && Array.isArray((step as { accepts?: unknown }).accepts)
      ? { accepts: [...new Set(((step as { accepts?: string[] }).accepts || []).map((value) => String(value).trim()).filter(Boolean))] }
      : {}),
    ...("terminal" in step ? { terminal: Boolean((step as { terminal?: unknown }).terminal) } : {}),
    ...(duplicatePolicy === "RETURN_RECORDED" || duplicatePolicy === "FAIL"
      ? { duplicatePolicy: duplicatePolicy as CommandDuplicatePolicy }
      : {})
  };
}

function extractAssistantContent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const ollamaMessage = (payload as { message?: { content?: unknown } }).message;
  const ollamaMessageContent = ollamaMessage?.content;
  if (typeof ollamaMessageContent === "string" && ollamaMessageContent.trim()) {
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

function extractOllamaStreamContent(rawBody: string): string | undefined {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const singlePayload = JSON.parse(trimmed);
    return extractAssistantContent(singlePayload);
  } catch {
  }

  let content = "";
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) {
      continue;
    }
    try {
      const payload = JSON.parse(candidate) as { message?: { content?: unknown } };
      const chunk = payload.message?.content;
      if (typeof chunk === "string") {
        content += chunk;
      }
    } catch {
    }
  }

  return content || undefined;
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

function parsePlannerDraftContent(
  content: string,
  options: { allowEmbeddedJson?: boolean } = {}
): PlannerDraft {
  const normalizedContent = unwrapJsonCodeFence(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch {
    if (!options.allowEmbeddedJson) {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }

    const extracted = extractFirstJsonObject(normalizedContent);
    if (!extracted) {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }

    try {
      parsed = JSON.parse(extracted);
    } catch {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }
  }

  try {
    return normalizePlannerDraft(plannerDraftSchema.parse(normalizeRecoverablePlannerDraftShape(parsed)));
  } catch (error) {
    throw new PlannerError(
      `Planner provider returned an invalid draft: ${error instanceof Error ? error.message : "schema validation failed"}`,
      502
    );
  }
}

function parseSemanticIntentContent(
  content: string,
  options: { allowEmbeddedJson?: boolean } = {}
): SemanticIntentDraft {
  const parsed = parseJsonContent(content, options);
  try {
    return semanticIntentSchema.parse(parsed);
  } catch (error) {
    throw new PlannerError(
      `Planner provider returned an invalid semantic intent draft: ${error instanceof Error ? error.message : "schema validation failed"}`,
      502
    );
  }
}

function parseJsonContent(
  content: string,
  options: { allowEmbeddedJson?: boolean } = {}
): unknown {
  const normalizedContent = unwrapJsonCodeFence(content);
  try {
    return JSON.parse(normalizedContent);
  } catch {
    if (!options.allowEmbeddedJson) {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }

    const extracted = extractFirstJsonObject(normalizedContent);
    if (!extracted) {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }

    try {
      return JSON.parse(extracted);
    } catch {
      throw new PlannerError("Planner provider returned invalid JSON content.", 502);
    }
  }
}

function unwrapJsonCodeFence(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function extractFirstJsonObject(content: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function normalizeRecoverablePlannerDraftShape(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  const draft = parsed as Record<string, unknown>;
  const businessSteps = Array.isArray(draft.businessSteps)
    ? draft.businessSteps.map((step, index) => normalizeRecoverableBusinessStep(step, index))
    : draft.businessSteps;
  const queries = normalizeRecoverableQueries(draft.queries, businessSteps);
  const pipelineSteps = Array.isArray(draft.pipelineSteps)
    ? draft.pipelineSteps.map((step, index) => normalizeRecoverablePipelineStep(step, index, businessSteps))
    : draft.pipelineSteps;
  const stepContracts = Array.isArray(draft.stepContracts)
    ? draft.stepContracts.map((contract, index) => normalizeRecoverableStepContract(contract, index, businessSteps))
    : draft.stepContracts;
  const contractQuestions = Array.isArray(draft.contractQuestions)
    ? draft.contractQuestions.map((question, index) => normalizeRecoverableContractQuestion(question, index, businessSteps))
    : draft.contractQuestions;

  return {
    ...draft,
    businessSteps,
    queries,
    pipelineSteps,
    stepContracts,
    contractQuestions
  };
}

function normalizeRecoverableBusinessStep(step: unknown, index: number): unknown {
  if (!step || typeof step !== "object") {
    return step;
  }

  const record = step as Record<string, unknown>;
  const inputTypeName = stringOrFallback(record.inputTypeName, `InputType${index + 1}`);
  const outputTypeName = stringOrFallback(record.outputTypeName, `OutputType${index + 1}`);
  const id = stringOrFallback(record.id, `step-${index + 1}`);
  const name = stringOrFallback(record.name, titleCaseFromIdentifier(id));

  return {
    ...record,
    id,
    name,
    purpose: stringOrFallback(record.purpose, `Implement ${name}.`),
    kind: normalizeRecoverableStepKind(record.kind),
    inputTypeName,
    outputTypeName,
    inputFields: Array.isArray(record.inputFields) ? record.inputFields : [],
    outputFields: Array.isArray(record.outputFields) ? record.outputFields : []
  };
}

function normalizeRecoverablePipelineStep(
  step: unknown,
  index: number,
  businessSteps: unknown
): unknown {
  if (!step || typeof step !== "object") {
    return step;
  }

  const record = step as Record<string, unknown>;
  const related = resolveRecoverableBusinessStep(record.id, record.name, index, businessSteps);
  const id = stringOrFallback(record.id, related?.id, `pipeline-step-${index + 1}`);
  const inputTypeName = stringOrFallback(record.inputTypeName, record.input, related?.inputTypeName, `InputType${index + 1}`);
  const outputTypeName = stringOrFallback(record.outputTypeName, record.output, related?.outputTypeName, `OutputType${index + 1}`);

  return {
    ...record,
    id,
    name: stringOrFallback(related?.name, record.name, titleCaseFromIdentifier(id)),
    kind: normalizeRecoverableStepKind(record.kind),
    inputTypeName,
    outputTypeName,
    cardinality: normalizeRecoverableCardinality(record.cardinality)
  };
}

function normalizeRecoverableStepContract(
  contract: unknown,
  index: number,
  businessSteps: unknown
): unknown {
  if (!contract || typeof contract !== "object") {
    return contract;
  }

  const record = contract as Record<string, unknown>;
  const related = resolveRecoverableBusinessStep(record.stepId, record.stepName, index, businessSteps);
  const stepName = stringOrFallback(related?.name, record.stepName, titleCaseFromIdentifier(stringOrFallback(record.stepId, related?.id, `step-${index + 1}`)));
  const stepId = resolveRecoverableStepId(record.stepId, stepName, index, businessSteps);

  return {
    ...record,
    stepId,
    stepName,
    kind: normalizeRecoverableStepKind(record.kind),
    inputTypeName: stringOrFallback(record.inputTypeName, related?.inputTypeName, `InputType${index + 1}`),
    outputTypeName: stringOrFallback(record.outputTypeName, related?.outputTypeName, `OutputType${index + 1}`),
    inputFields: Array.isArray(record.inputFields) ? record.inputFields : [],
    outputFields: Array.isArray(record.outputFields) ? record.outputFields : [],
    continuity: record.continuity === "coherent" || record.continuity === "clarification_needed"
      ? record.continuity
      : "clarification_needed",
    rationale: stringOrFallback(record.rationale, `Need clarification for ${stepName}.`)
  };
}

function normalizeRecoverableContractQuestion(
  question: unknown,
  index: number,
  businessSteps: unknown
): unknown {
  if (typeof question === "string") {
    const related = Array.isArray(businessSteps)
      ? businessSteps[Math.min(index, Math.max(businessSteps.length - 1, 0))] as Record<string, unknown> | undefined
      : undefined;
    const stepId = stringOrUndefined(related?.id);
    const stepName = stringOrUndefined(related?.name);
    const messageTypeName = stringOrFallback(related?.outputTypeName, `OutputType${index + 1}`);
    return {
      id: `contract-question-${index + 1}`,
      key: "stepContracts",
      prompt: question,
      ...(stepId ? { stepId } : {}),
      ...(stepName ? { stepName } : {}),
      kind: "fields",
      messageTypeName,
      expectedAnswerShape: {
        type: "fields",
        description: "Confirm or edit the fields for this step contract."
      },
      resolutionModes: ["replace", "edit"]
    };
  }

  return question;
}

function normalizeRecoverableQueries(
  queries: unknown,
  businessSteps: unknown
): unknown {
  if (!queries || typeof queries !== "object" || Array.isArray(queries)) {
    return queries;
  }

  const stepByQueryId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(businessSteps)) {
    for (const step of businessSteps) {
      if (step && typeof step === "object") {
        const record = step as Record<string, unknown>;
        const queryId = stringOrUndefined(record.query);
        if (queryId) {
          stepByQueryId.set(queryId, record);
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(queries as Record<string, unknown>).map(([id, query]) => [
      id,
      normalizeRecoverableQueryDefinition(id, query, stepByQueryId.get(id))
    ])
  );
}

function normalizeRecoverableQueryDefinition(
  queryId: string,
  query: unknown,
  relatedStep: Record<string, unknown> | undefined
): unknown {
  if (!query || typeof query !== "object") {
    return query;
  }

  const record = query as Record<string, unknown>;
  const normalizedInputType = resolveRecoverableQueryTypeAlias(record.inputType, record.input, relatedStep?.inputTypeName);
  const normalizedOutputType = resolveRecoverableQueryTypeAlias(record.outputType, record.output, relatedStep?.outputTypeName);
  const { input: _input, inputType: _inputType, output: _output, outputType: _outputType, ...rest } = record;

  return {
    ...rest,
    ...(normalizedInputType?.canonical ? { inputType: normalizedInputType.canonical } : {}),
    ...(normalizedInputType?.alias ? { input: normalizedInputType.alias } : {}),
    ...(normalizedOutputType?.canonical ? { outputType: normalizedOutputType.canonical } : {}),
    ...(normalizedOutputType?.alias ? { output: normalizedOutputType.alias } : {}),
    ...(typeof record.query === "undefined" ? {} : { query: queryId })
  };
}

function resolveRecoverableQueryTypeAlias(
  canonical: unknown,
  alias: unknown,
  relatedTypeName: unknown
): { canonical?: string; alias?: string } | undefined {
  const canonicalString = stringOrUndefined(canonical);
  const aliasString = stringOrUndefined(alias);
  const relatedString = stringOrUndefined(relatedTypeName);

  if (canonicalString && aliasString && canonicalString !== aliasString) {
    if (relatedString && plannerTypeNamesMatch(canonicalString, relatedString)) {
      return { canonical: canonicalString };
    }
    if (relatedString && plannerTypeNamesMatch(aliasString, relatedString)) {
      return { canonical: aliasString };
    }
    return { canonical: canonicalString, alias: aliasString };
  }

  if (canonicalString || aliasString) {
    return {
      ...(canonicalString ? { canonical: canonicalString } : {}),
      ...(!canonicalString && aliasString ? { canonical: aliasString } : {}),
      ...(canonicalString && aliasString && canonicalString === aliasString ? {} : {})
    };
  }

  if (relatedString) {
    return { canonical: relatedString };
  }

  return undefined;
}

function normalizeRecoverableStepKind(value: unknown): unknown {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return value;
  }
  if (["internal", "delegated", "remote", "await", "query", "command"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "input" || normalized === "process" || normalized === "output") {
    return "internal";
  }
  return value;
}

function resolveRecoverableStepId(
  candidate: unknown,
  stepName: string,
  index: number,
  businessSteps: unknown
): string {
  const related = resolveRecoverableBusinessStep(candidate, stepName, index, businessSteps);
  if (related?.id && typeof related.id === "string") {
    return related.id;
  }

  const normalizedCandidate = stringOrUndefined(candidate);
  return normalizedCandidate || `step-${index + 1}`;
}

function resolveRecoverableBusinessStep(
  candidate: unknown,
  stepName: unknown,
  index: number,
  businessSteps: unknown
): Record<string, unknown> | undefined {
  const steps = Array.isArray(businessSteps) ? businessSteps as Array<Record<string, unknown>> : [];
  const normalizedCandidate = stringOrUndefined(candidate);
  if (normalizedCandidate) {
    const exact = steps.find((step) => step.id === normalizedCandidate);
    if (exact) {
      return exact;
    }

    const candidateIdentifier = normalizeIdentifier(normalizedCandidate);
    const matchingById = steps.find((step) => normalizeIdentifier(String(step.id || "")) === candidateIdentifier);
    if (matchingById) {
      return matchingById;
    }
  }

  const normalizedName = normalizeIdentifier(String(stepName || ""));
  if (normalizedName) {
    const matchingByName = steps.find((step) => normalizeIdentifier(String(step.name || "")) === normalizedName);
    if (matchingByName) {
      return matchingByName;
    }
  }

  return steps[index];
}

function normalizeRecoverableCardinality(value: unknown): unknown {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!normalized) {
    return "ONE_TO_ONE";
  }
  if ([
    "ONE_TO_ONE",
    "EXPANSION",
    "REDUCTION",
    "SIDE_EFFECT",
    "MANY_TO_MANY",
    "ONE_TO_MANY",
    "MANY_TO_ONE"
  ].includes(normalized)) {
    return normalized;
  }
  return "ONE_TO_ONE";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringOrFallback(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function titleCaseFromIdentifier(value: string): string {
  return value
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeIdentifier(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return compact.replace(/^(?:step|ps|bs|pipeline|contract)+/, "");
}

function plannerTypeNamesMatch(left: string, right: string): boolean {
  return normalizeIdentifier(left) === normalizeIdentifier(right);
}

function plannerDraftFromAnalysis(analysis: Awaited<ReturnType<typeof analyzeBrief>>): PlannerDraft {
  return {
    title: analysis.pipelineSummary.title,
    primaryGoal: analysis.pipelineSummary.primaryGoal,
    outputArtifact: analysis.pipelineSummary.outputArtifact,
    businessSteps: analysis.businessSteps,
    pipelineSteps: analysis.inferredSteps,
    messageCatalog: analysis.messageCatalog,
    unions: analysis.derivedConfig.unions,
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

function applyContractAnswersToPlannerDraft(
  draft: PlannerDraft,
  answers: Record<string, ContractAnswerRecord>
): PlannerDraft {
  const answeredIds = new Set(Object.keys(answers));
  const next = clonePlannerDraft(draft);
  const contractQuestionsById = new Map(next.contractQuestions.map((question) => [question.id, question] as const));

  for (const [questionId, answer] of Object.entries(answers)) {
    const question = contractQuestionsById.get(questionId);
    if (!question?.messageTypeName || !answer.fields) {
      continue;
    }

    const fields = answer.fields.map(contractFieldToMessageField);
    const message = next.messageCatalog.find((entry) => entry.name === question.messageTypeName);
    if (message) {
      message.fields = fields;
    } else {
      next.messageCatalog.push({
        id: `message.${normalizeIdentifier(question.messageTypeName)}`,
        name: question.messageTypeName,
        fields
      });
    }

    applyAnsweredFieldsToBusinessSteps(next.businessSteps, question, fields);
    applyAnsweredFieldsToContracts(next.stepContracts, question, fields);
  }

  for (const contract of next.stepContracts) {
    if (contract.inputFields.length > 0 && contract.outputFields.length > 0) {
      contract.continuity = "coherent";
    }
  }

  next.questions = (next.questions || []).filter((question) => !answeredIds.has(question.id));
  next.contractQuestions = next.contractQuestions.filter((question) => !answeredIds.has(question.id));
  return next;
}

function applyAnsweredFieldsToBusinessSteps(
  steps: PlannerDraft["businessSteps"],
  question: PlannerDraft["contractQuestions"][number],
  fields: MessageField[]
): void {
  for (const step of steps) {
    if (step.inputTypeName === question.messageTypeName) {
      if (!question.stepId || step.id === question.stepId) {
        step.inputFields = fields;
      }
    }
    if (step.outputTypeName === question.messageTypeName) {
      if (!question.stepId || step.id === question.stepId) {
        step.outputFields = fields;
      }
    }
  }
}

function applyAnsweredFieldsToContracts(
  contracts: PlannerDraft["stepContracts"],
  question: PlannerDraft["contractQuestions"][number],
  fields: MessageField[]
): void {
  for (const contract of contracts) {
    if (contract.inputTypeName === question.messageTypeName) {
      if (!question.stepId || contract.stepId === question.stepId) {
        contract.inputFields = fields;
      }
    }
    if (contract.outputTypeName === question.messageTypeName) {
      if (!question.stepId || contract.stepId === question.stepId) {
        contract.outputFields = fields;
      }
    }
  }
}

function contractFieldToMessageField(
  field: NonNullable<ContractAnswerRecord["fields"]>[number],
  index: number
): MessageField {
  return {
    number: index + 1,
    name: field.name,
    type: field.type,
    ...(field.required === false ? { optional: true } : {}),
    ...(field.repeated ? { repeated: true } : {})
  };
}

function clonePlannerDraft(draft: PlannerDraft): PlannerDraft {
  return JSON.parse(JSON.stringify(draft)) as PlannerDraft;
}

function compileSemanticIntentDraftToPlannerDraft(intent: SemanticIntentDraft): PlannerDraft {
  const messageIndex = new Map<string, MessageCatalogEntry>();
  const unionIndex: Record<string, UnionDefinition> = {};
  const contractQuestions: PlannerDraft["contractQuestions"] = [];
  const contractQuestionIds = new Set<string>();
  const technicalConcerns: NonNullable<PlannerDraft["technicalConcerns"]> = [];
  const compiledAssumptions = [...intent.assumptions];
  const businessSteps: PlannerDraft["businessSteps"] = [];
  const pipelineSteps: PlannerDraft["pipelineSteps"] = [];
  const stepContracts: PlannerDraft["stepContracts"] = [];
  const queries: NonNullable<PlannerDraft["queries"]> = {};
  const progressionProtocol = indicatesProgressionProtocolWorkflow(intent);

  const pushContractQuestion = (question: PlannerDraft["contractQuestions"][number]): void => {
    const equivalentIndex = contractQuestions.findIndex((candidate) => (
      candidate.key === question.key
      && candidate.kind === question.kind
      && candidate.messageTypeName === question.messageTypeName
    ));
    if (equivalentIndex >= 0) {
      const existing = contractQuestions[equivalentIndex];
      if (question.proposedAnswer && !existing.proposedAnswer) {
        contractQuestions[equivalentIndex] = {
          ...question,
          id: existing.id
        };
      }
      return;
    }
    if (contractQuestionIds.has(question.id)) {
      return;
    }
    contractQuestionIds.add(question.id);
    contractQuestions.push(question);
  };

  const pushTechnicalConcern = (concern: NonNullable<PlannerDraft["technicalConcerns"]>[number]): void => {
    if (technicalConcerns.some((current) => current.concern === concern.concern)) {
      return;
    }
    technicalConcerns.push(concern);
  };

  const pushFieldContractQuestion = (input: {
    id: string;
    stepId: string;
    stepName: string;
    messageTypeName: string;
    prompt: string;
    description: string;
    fields: MessageField[];
  }): void => {
    pushContractQuestion({
      id: input.id,
      key: "stepContracts",
      stepId: input.stepId,
      stepName: input.stepName,
      kind: "fields",
      messageTypeName: input.messageTypeName,
      prompt: input.prompt,
      expectedAnswerShape: {
        type: "fields",
        description: input.description
      },
      ...(input.fields.length > 0 ? {
        proposedAnswer: {
          questionId: input.id,
          fields: input.fields.map((field) => ({
            name: field.name,
            type: field.type,
            required: !field.optional,
            repeated: field.repeated
          }))
        },
        resolutionModes: ["confirm", "replace", "edit"] as const
      } : {
        resolutionModes: ["replace", "edit"] as const
      })
    });
  };

  for (const message of intent.messages) {
    const normalizedName = normalizeTypeName(message.name);
    if (!normalizedName) {
      continue;
    }
    messageIndex.set(normalizedName, {
      id: `message.${normalizeIdentifier(normalizedName)}`,
      name: normalizedName,
      fields: toMessageFields(message.fields)
    });
  }

  for (const union of intent.unions || []) {
    const unionName = normalizeTypeName(union.name);
    if (!unionName) {
      continue;
    }
    const variantKeys = new Set<string>();
    const variantEntries = union.variants.map((variant, index) => {
      const key = normalizeIdentifier(variant.name);
      if (!key) {
        throw new Error(`Semantic intent union '${unionName}' has a variant with an invalid name '${variant.name}'.`);
      }
      if (variantKeys.has(key)) {
        throw new Error(`Semantic intent union '${unionName}' has duplicate variant key '${key}'.`);
      }
      variantKeys.add(key);
      return [
        key,
        {
          type: normalizeTypeName(variant.type) || `Variant${index + 1}`,
          number: variant.number ?? index + 1
        }
      ] as const;
    });
    unionIndex[unionName] = {
      variants: Object.fromEntries(variantEntries)
    };
  }

  const synthesizedQuestionKeys = new Set<string>();
  const ensureMessage = (name: string, step: SemanticIntentDraft["steps"][number], direction: "input" | "output"): MessageCatalogEntry => {
    const normalizedName = normalizeTypeName(name) || `${direction === "input" ? "Input" : "Output"}Message`;
    if (unionIndex[normalizedName]) {
      throw new Error(`Semantic intent ${direction} '${normalizedName}' is a union and cannot be materialized as a message.`);
    }
    const existing = messageIndex.get(normalizedName);
    if (existing) {
      return existing;
    }

    const synthesized: MessageCatalogEntry = {
      id: `message.${normalizeIdentifier(normalizedName)}`,
      name: normalizedName,
      fields: []
    };
    messageIndex.set(normalizedName, synthesized);

    const questionId = `contract.${normalizeIdentifier(step.id)}.${direction}.${normalizeIdentifier(normalizedName)}`;
    if (!synthesizedQuestionKeys.has(questionId)) {
      synthesizedQuestionKeys.add(questionId);
      pushFieldContractQuestion({
        id: questionId,
        stepId: normalizeStepId(step.id),
        stepName: step.name.trim() || titleCaseFromIdentifier(step.id),
        messageTypeName: normalizedName,
        prompt: `Confirm the ${direction} fields for ${step.name.trim() || titleCaseFromIdentifier(step.id)}.`,
        description: `Define the fields for ${normalizedName}.`,
        fields: synthesized.fields
      });
    }

    return synthesized;
  };

  intent.steps.forEach((step, index) => {
    const stepId = normalizeStepId(step.id, index);
    const stepName = step.name.trim() || titleCaseFromIdentifier(stepId);
    const inputTypeName = normalizeTypeName(step.input) || "InputMessage";
    const outputTypeName = normalizeTypeName(step.output) || "OutputMessage";
    const inputIsUnion = Boolean(unionIndex[inputTypeName]);
    const outputIsUnion = Boolean(unionIndex[outputTypeName]);
    const inputMessage = inputIsUnion
      ? { id: `union.${normalizeIdentifier(inputTypeName)}`, name: inputTypeName, fields: [] }
      : ensureMessage(inputTypeName, step, "input");
    const outputMessage = outputIsUnion
      ? { id: `union.${normalizeIdentifier(outputTypeName)}`, name: outputTypeName, fields: [] }
      : ensureMessage(outputTypeName, step, "output");
    const continuity = (inputIsUnion || inputMessage.fields.length > 0) && (outputIsUnion || outputMessage.fields.length > 0)
      ? "coherent"
      : "clarification_needed";
    const kind = step.kind as StepKind;
    const cardinality = normalizeCompiledSemanticCardinality(kind, step.cardinality as StepCardinality);
    const acceptedContracts = [...new Set((step.accepts || []).map((value) => normalizeTypeName(value)).filter(Boolean))];
    const terminal = Boolean(step.terminal);
    const sharedFields = buildCompiledStepMetadata(stepId, stepName, kind, inputMessage.name, outputMessage.name, cardinality);
    const resumeSurface = progressionProtocol && kind !== "query" && isResumeBoundarySemanticStep(step);

    const businessStep: PlannerDraft["businessSteps"][number] = {
      id: stepId,
      name: stepName,
      purpose: step.purpose.trim() || `Implement ${stepName}.`,
      kind,
      inputTypeName: inputMessage.name,
      outputTypeName,
      ...(acceptedContracts.length > 0 ? { accepts: acceptedContracts } : {}),
      ...(terminal ? { terminal: true } : {}),
      inputFields: inputMessage.fields,
      outputFields: unionIndex[outputTypeName] ? [] : outputMessage.fields,
      ...(resumeSurface
        ? {
            flowRole: "resume" as const,
            flowBoundaryRationale: "Resume/load-state is a separate query/resumption surface, not part of the forward-processing pipeline."
          }
        : {}),
      ...sharedFields.business
    };
    businessSteps.push(businessStep);

    if (!resumeSurface) {
      pipelineSteps.push({
        id: stepId,
        name: stepName,
        kind,
        cardinality,
        inputTypeName: inputMessage.name,
        outputTypeName,
        ...(acceptedContracts.length > 0 ? { accepts: acceptedContracts } : {}),
        ...(terminal ? { terminal: true } : {}),
        ...sharedFields.pipeline
      });
    } else {
      compiledAssumptions.push(
        `Step '${stepName}' was compiled as a separate resume/load-state surface rather than a forward pipeline step.`
      );
    }

    stepContracts.push({
      stepId,
      stepName,
      kind,
      inputTypeName: inputMessage.name,
      outputTypeName,
      ...(acceptedContracts.length > 0 ? { accepts: acceptedContracts } : {}),
      ...(terminal ? { terminal: true } : {}),
      inputFields: inputMessage.fields,
      outputFields: unionIndex[outputTypeName] ? [] : outputMessage.fields,
      continuity,
      rationale: continuity === "coherent"
        ? `Compiled from Ollama semantic intent for ${stepName}.`
        : `Compiled from Ollama semantic intent for ${stepName}; contract fields still need confirmation.`,
      ...(resumeSurface
        ? {
            flowRole: "resume" as const,
            flowBoundaryRationale: "Resume/load-state is a separate query/resumption surface, not part of the forward-processing pipeline."
          }
        : {}),
      ...sharedFields.contract
    });

    if (kind === "query") {
      const queryId = sharedFields.queryId || stepId;
      queries[queryId] = {
        connector: "jpa",
        inputType: inputMessage.name,
        outputType: outputTypeName,
        jpa: {
          entity: `${simpleTypeName(outputTypeName)}Entity`,
          where: {
            id: "input.id"
          }
        }
      };
      pushFieldContractQuestion({
        id: `contract.${normalizeIdentifier(stepId)}.query`,
        stepId,
        stepName,
        messageTypeName: outputTypeName,
        prompt: `Confirm the query criteria and result fields for ${stepName}.`,
        description: `Confirm the fields returned by ${stepName}.`,
        fields: unionIndex[outputTypeName] ? [] : outputMessage.fields
      });
    }

    if (kind === "command") {
      pushFieldContractQuestion({
        id: `contract.${normalizeIdentifier(stepId)}.command.output.${normalizeIdentifier(outputTypeName)}`,
        stepId,
        stepName,
        messageTypeName: outputTypeName,
        prompt: `Confirm the output fields produced by the command step ${stepName}.`,
        description: `Confirm the fields produced by ${stepName}.`,
        fields: unionIndex[outputTypeName] ? [] : outputMessage.fields
      });
    }

    if (kind === "await") {
      pushFieldContractQuestion({
        id: `contract.${normalizeIdentifier(stepId)}.await`,
        stepId,
        stepName,
        messageTypeName: outputTypeName,
        prompt: `Confirm the resume contract for ${stepName}.`,
        description: `Confirm the fields needed to resume ${stepName}.`,
        fields: unionIndex[outputTypeName] ? [] : outputMessage.fields
      });
    }
  });

  intent.questions.forEach((question, index) => {
    const relatedStep = intent.steps[Math.min(index, Math.max(intent.steps.length - 1, 0))];
    const relatedMessageName = relatedStep
      ? normalizeTypeName(relatedStep.output) || normalizeTypeName(relatedStep.input) || "UnknownMessage"
      : "UnknownMessage";
    pushContractQuestion({
      id: `contract.question.${index + 1}`,
      key: "stepContracts",
      ...(relatedStep ? { stepId: normalizeStepId(relatedStep.id), stepName: relatedStep.name.trim() || titleCaseFromIdentifier(relatedStep.id) } : {}),
      kind: "fields",
      messageTypeName: relatedMessageName,
      prompt: question,
      expectedAnswerShape: {
        type: "fields",
        description: "Confirm or edit the relevant contract fields."
      },
      resolutionModes: ["replace", "edit"]
    });
  });

  if (progressionProtocol) {
    compiledAssumptions.push(
      "Loop-like workflow was compiled as replayable state-advancing invocations over durable aggregate state."
    );
  }
  realignCompiledForwardChain(
    businessSteps,
    pipelineSteps,
    stepContracts,
    messageIndex,
    queries,
    pushContractQuestion,
    compiledAssumptions,
    progressionProtocol
  );
  pruneContractQuestionsForKnownMessages(contractQuestions, messageIndex);

  if (progressionProtocol) {
    addProgressionProtocolConcerns([...messageIndex.values()], businessSteps, pushTechnicalConcern);
  }

  return {
    title: intent.title,
    primaryGoal: intent.primaryGoal,
    businessSteps,
    pipelineSteps,
    messageCatalog: [...messageIndex.values()],
    ...(Object.keys(unionIndex).length > 0 ? { unions: unionIndex } : {}),
    stepContracts,
    contractQuestions,
    futureStepCandidates: [],
    assumptions: compiledAssumptions,
    questions: [],
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    ...(Object.keys(queries).length > 0 ? { queries } : {}),
    ...(technicalConcerns.length > 0 ? { technicalConcerns } : {})
  };
}

function buildCompiledStepMetadata(
  stepId: string,
  stepName: string,
  kind: StepKind,
  inputTypeName: string,
  outputTypeName: string,
  cardinality: StepCardinality
): {
  queryId?: string;
  business: Partial<PlannerDraft["businessSteps"][number]>;
  pipeline: Partial<PlannerDraft["pipelineSteps"][number]>;
  contract: Partial<PlannerDraft["stepContracts"][number]>;
} {
  const flowMetadata = deriveCompiledFlowMetadata(kind, cardinality);

  if (kind === "query") {
    const queryId = stepId;
    const queryFields = { query: queryId, ...flowMetadata };
    return {
      queryId,
      business: queryFields,
      pipeline: queryFields,
      contract: queryFields
    };
  }

  if (kind === "command") {
    const command = `${normalizeIdentifier(stepId)}.execute`;
    const commandFields = {
      command,
      duplicatePolicy: "RETURN_RECORDED" as CommandDuplicatePolicy,
      ...flowMetadata
    };
    return {
      business: commandFields,
      pipeline: commandFields,
      contract: commandFields
    };
  }

  if (kind === "await") {
    const idempotencyKeyField = inferIdempotencyKeyFieldName(inputTypeName);
    const awaitFields = {
      timeout: "PT15M",
      idempotencyKeyFields: [idempotencyKeyField],
      await: {
        correlation: { strategy: "interactionId" as const },
        transport: {
          type: "interaction-api" as const
        }
      },
      ...flowMetadata
    };
    return {
      business: awaitFields,
      pipeline: {
        ...awaitFields,
        cardinality
      },
      contract: awaitFields
    };
  }

  return {
    business: flowMetadata,
    pipeline: { cardinality, ...flowMetadata },
    contract: flowMetadata
  };
}

function normalizeCompiledSemanticCardinality(kind: StepKind, cardinality: StepCardinality): StepCardinality {
  if (kind === "query" || kind === "command") {
    return "ONE_TO_ONE";
  }
  return cardinality;
}

function deriveCompiledFlowMetadata(
  kind: StepKind,
  cardinality: StepCardinality
): Partial<Pick<PlannerDraft["businessSteps"][number], "flowRole">> {
  if (kind === "query") {
    return { flowRole: "query" };
  }
  if (cardinality === "EXPANSION") {
    return { flowRole: "expansion" };
  }
  if (cardinality === "REDUCTION") {
    return { flowRole: "reduction" };
  }
  return {};
}

function toMessageFields(fields: Array<{ name: string; type: string }>): MessageField[] {
  return fields
    .map((field, index) => ({
      number: index + 1,
      name: field.name.trim(),
      type: field.type.trim()
    }))
    .filter((field) => field.name && field.type);
}

function normalizeStepId(value: string, index = 0): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || `step-${index + 1}`;
}

function normalizeTypeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/[a-z][A-Z]/.test(trimmed) || /^[A-Z][A-Za-z0-9]*$/.test(trimmed)) {
    return trimmed.replace(/[^A-Za-z0-9]/g, "");
  }
  return trimmed
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function simpleTypeName(typeName: string): string {
  const normalized = normalizeTypeName(typeName);
  return normalized.split(".").pop() || normalized || "Message";
}

function inferIdempotencyKeyFieldName(typeName: string): string {
  const simpleName = simpleTypeName(typeName);
  if (/resume|callback|interaction/i.test(simpleName)) {
    return "interactionId";
  }
  return "requestId";
}

function indicatesProgressionProtocolWorkflow(intent: SemanticIntentDraft): boolean {
  const combined = [
    intent.title,
    intent.primaryGoal,
    ...intent.assumptions,
    ...intent.questions,
    ...intent.steps.flatMap((step) => [step.id, step.name, step.purpose, step.input, step.output]),
    ...intent.messages.flatMap((message) => [message.name, ...message.fields.flatMap((field) => [field.name, field.type])])
  ].join(" ");

  return /\b(resume|partial|stage|progress|continue|return|later|retry|multiple times|repeated|incomplete|state|current state|aggregate)\b/i.test(combined);
}

function isResumeBoundarySemanticStep(step: SemanticIntentDraft["steps"][number]): boolean {
  const combined = [step.id, step.name, step.purpose, step.input, step.output].join(" ");
  return /\b(resume|load|reload|rehydrate|return later|continue later|existing progress|last completed)\b/i.test(combined);
}

function realignCompiledForwardChain(
  businessSteps: PlannerDraft["businessSteps"],
  pipelineSteps: PlannerDraft["pipelineSteps"],
  stepContracts: PlannerDraft["stepContracts"],
  messageIndex: Map<string, MessageCatalogEntry>,
  queries: NonNullable<PlannerDraft["queries"]>,
  pushContractQuestion: (question: PlannerDraft["contractQuestions"][number]) => void,
  assumptions: string[],
  progressionProtocol: boolean
): void {
  const contractById = new Map(stepContracts.map((contract) => [contract.stepId, contract]));
  const pipelineById = new Map(pipelineSteps.map((step) => [step.id || normalizeStepId(step.name), step]));
  const forwardSteps = businessSteps.filter(isCompiledForwardChainStep);

  for (let index = 1; index < forwardSteps.length; index += 1) {
    const previous = forwardSteps[index - 1];
    const current = forwardSteps[index];
    const previousContract = contractById.get(previous.id);
    const previousPipelineStep = pipelineById.get(previous.id);

    if (shouldUseQueryContextEnvelope(previous, current)) {
      const queryResultTypeName = previous.outputTypeName;
      const envelope = buildQueryContextEnvelopeMessage(previous.inputTypeName, queryResultTypeName, current.name);
      const existing = messageIndex.get(envelope.name);
      if (existing) {
        const envelopeSignature = JSON.stringify(envelope.fields);
        const existingSignature = JSON.stringify(existing.fields);
        if (envelopeSignature !== existingSignature) {
          const suffix = Date.now().toString(36);
          envelope.name = `${envelope.name}_${suffix}`;
          envelope.id = `message.${normalizeIdentifier(envelope.name)}`;
        }
      }
      messageIndex.set(envelope.name, envelope);

      previous.outputTypeName = envelope.name;
      previous.outputFields = envelope.fields;
      if (previousContract) {
        previousContract.outputTypeName = envelope.name;
        previousContract.outputFields = envelope.fields;
        previousContract.continuity = previousContract.inputFields.length > 0 ? "coherent" : previousContract.continuity;
      }
      if (previousPipelineStep) {
        previousPipelineStep.outputTypeName = envelope.name;
      }

      const queryId = previous.query?.trim();
      if (queryId && queries[queryId]) {
        queries[queryId] = {
          ...queries[queryId],
          outputType: envelope.name
        };
      }

      const contract = contractById.get(current.id);
      const pipelineStep = pipelineById.get(current.id);
      current.inputTypeName = envelope.name;
      current.inputFields = envelope.fields;
      if (contract) {
        contract.inputTypeName = envelope.name;
        contract.inputFields = envelope.fields;
        contract.continuity = contract.outputFields.length > 0 ? "coherent" : "clarification_needed";
        contract.rationale = `Compiled from semantic intent for ${current.name}; input uses an original-input-plus-query-result envelope.`;
      }
      if (pipelineStep) {
        pipelineStep.inputTypeName = envelope.name;
      }

      assumptions.push(
        `Compiled query step '${previous.name}' and step '${current.name}' through envelope '${envelope.name}' carrying original input '${previous.inputTypeName}' plus query result '${queryResultTypeName}'.`
      );
      pushEnvelopeContractQuestion(current, envelope, pushContractQuestion, {
        prompt: `Confirm the original-input-plus-query-result envelope for ${current.name}.`,
        description: "Confirm the envelope fields that carry the original request or command plus the lookup/query result."
      });
      continue;
    }

    if (shouldUseAwaitSubmissionEnvelope(previous, current)) {
      const submittedTypeName = chooseSubmittedPayloadTypeName(messageIndex, previous, current);
      const proposedEnvelope = buildSubmissionEnvelopeMessage(previous.inputTypeName, submittedTypeName);
      const envelope = resolveCanonicalEnvelopeMessage(messageIndex, proposedEnvelope, [
        previous.outputTypeName,
        current.inputTypeName
      ]);
      messageIndex.set(envelope.name, envelope);
      removeEquivalentEnvelopeAliases(messageIndex, envelope);
      removeSubmissionEnvelopeAliasNames(messageIndex, envelope.name, submittedTypeName, [
        previous.outputTypeName,
        current.inputTypeName
      ]);

      previous.outputTypeName = envelope.name;
      previous.outputFields = envelope.fields;
      if (previousContract) {
        previousContract.outputTypeName = envelope.name;
        previousContract.outputFields = envelope.fields;
        previousContract.continuity = previousContract.inputFields.length > 0 ? "coherent" : previousContract.continuity;
      }
      if (previousPipelineStep) {
        previousPipelineStep.outputTypeName = envelope.name;
      }

      const contract = contractById.get(current.id);
      const pipelineStep = pipelineById.get(current.id);
      current.inputTypeName = envelope.name;
      current.inputFields = envelope.fields;
      if (contract) {
        contract.inputTypeName = envelope.name;
        contract.inputFields = envelope.fields;
        contract.continuity = contract.outputFields.length > 0 ? "coherent" : "clarification_needed";
        contract.rationale = `Compiled from semantic intent for ${current.name}; input uses a state-plus-submission envelope to preserve await boundary context.`;
      }
      if (pipelineStep) {
        pipelineStep.inputTypeName = envelope.name;
      }

      assumptions.push(
        `Compiled await boundary '${previous.name}' and step '${current.name}' through envelope '${envelope.name}' carrying state '${previous.inputTypeName}' plus submitted payload '${submittedTypeName}'.`
      );
      pushEnvelopeContractQuestion(current, envelope, pushContractQuestion, {
        prompt: `Confirm the state-plus-submission envelope for ${current.name}.`,
        description: "Confirm the envelope fields that carry current aggregate state plus the submitted external payload."
      });
      continue;
    }

    if (current.inputTypeName === previous.outputTypeName || !progressionProtocol) {
      continue;
    }

    const contract = contractById.get(current.id);
    const pipelineStep = pipelineById.get(current.id);
    if (!contract || !pipelineStep) {
      continue;
    }

    const originalInputTypeName = current.inputTypeName;
    const originalInputFields = current.inputFields;

    current.inputTypeName = previous.outputTypeName;
    current.inputFields = previous.outputFields;
    contract.inputTypeName = previous.outputTypeName;
    contract.inputFields = previous.outputFields;
    contract.continuity = "clarification_needed";
    contract.rationale = `Compiled from Ollama semantic intent for ${current.name}; input was realigned to preserve monotonic aggregate-state progression.`;
    pipelineStep.inputTypeName = previous.outputTypeName;

    if (current.kind === "query") {
      const queryId = current.query?.trim();
      if (queryId && queries[queryId]) {
        queries[queryId] = {
          ...queries[queryId],
          inputType: previous.outputTypeName
        };
      }
    }

    assumptions.push(
      `Realigned forward step '${current.name}' input from '${originalInputTypeName}' to '${previous.outputTypeName}' to preserve progression-protocol continuity.`
    );

    pushContractQuestion({
      id: `contract.${normalizeIdentifier(current.id)}.progression`,
      key: "stepContracts",
      stepId: current.id,
      stepName: current.name,
      kind: "fields",
      messageTypeName: previous.outputTypeName,
      prompt: `Confirm the aggregate-state input for ${current.name}.`,
      expectedAnswerShape: {
        type: "fields",
        description: "Confirm the fields carried into the next state-advancing invocation."
      },
      proposedAnswer: {
        questionId: `contract.${normalizeIdentifier(current.id)}.progression`,
        fields: previous.outputFields.map((field) => ({
          name: field.name,
          type: field.type
        }))
      },
      resolutionModes: ["confirm", "replace", "edit"]
    });

    if (originalInputFields.length > 0 && originalInputTypeName !== previous.outputTypeName) {
      pushContractQuestion({
        id: `contract.${normalizeIdentifier(current.id)}.original-shape`,
        key: "stepContracts",
        stepId: current.id,
        stepName: current.name,
        kind: "fields",
        messageTypeName: originalInputTypeName,
        prompt: `If ${originalInputTypeName} is still required for ${current.name}, describe the missing boundary that should produce it.`,
        expectedAnswerShape: {
          type: "fields",
          description: "Describe the fields for the model-suggested input shape if it remains necessary."
        },
        proposedAnswer: {
          questionId: `contract.${normalizeIdentifier(current.id)}.original-shape`,
          fields: originalInputFields.map((field) => ({
            name: field.name,
            type: field.type
          }))
        },
        resolutionModes: ["replace", "edit"]
      });
    }
  }
}

function shouldUseAwaitSubmissionEnvelope(
  previous: PlannerDraft["businessSteps"][number],
  current: PlannerDraft["businessSteps"][number]
): boolean {
  if (previous.kind !== "await" || current.kind !== "internal") {
    return false;
  }
  if (!previous.inputTypeName || !previous.outputTypeName || previous.inputTypeName === previous.outputTypeName) {
    return false;
  }
  const combined = [current.id, current.name, current.purpose].join(" ");
  return /\b(validate|validation|advance|apply|process|submit|segment|submission|stage)\b/i.test(combined)
    || isCompositeTypeName(current.inputTypeName);
}

function shouldUseQueryContextEnvelope(
  previous: PlannerDraft["businessSteps"][number],
  current: PlannerDraft["businessSteps"][number]
): boolean {
  if (previous.kind !== "query" || current.kind !== "internal") {
    return false;
  }
  if (!previous.inputTypeName || !previous.outputTypeName || previous.inputTypeName === previous.outputTypeName) {
    return false;
  }
  const combined = [current.id, current.name, current.purpose].join(" ");
  return /\b(validate|validation|check|verify|decide|assess|process)\b/i.test(combined)
    || isCompositeTypeName(current.inputTypeName);
}

function chooseSubmittedPayloadTypeName(
  messageIndex: Map<string, MessageCatalogEntry>,
  previous: PlannerDraft["businessSteps"][number],
  current: PlannerDraft["businessSteps"][number]
): string {
  const envelopePayloadType = submittedPayloadTypeFromEnvelope(messageIndex, previous.inputTypeName, [
    previous.outputTypeName,
    current.inputTypeName
  ]);
  if (envelopePayloadType) {
    return envelopePayloadType;
  }

  const aliasPayloadType = submittedPayloadTypeFromAliasName(messageIndex, previous.inputTypeName, [
    previous.outputTypeName,
    current.inputTypeName
  ]);
  if (aliasPayloadType) {
    return aliasPayloadType;
  }

  if (current.inputTypeName && current.inputTypeName !== previous.inputTypeName && !isCompositeTypeName(current.inputTypeName)) {
    return current.inputTypeName;
  }
  return previous.outputTypeName;
}

function submittedPayloadTypeFromEnvelope(
  messageIndex: Map<string, MessageCatalogEntry>,
  stateTypeName: string,
  candidateNames: string[]
): string | undefined {
  const normalizedStateType = normalizeTypeName(stateTypeName);
  for (const name of candidateNames) {
    const message = messageIndex.get(normalizeTypeName(name));
    if (!message || message.fields.length !== 2) {
      continue;
    }
    const [first, second] = message.fields;
    if (normalizeTypeName(first.type) === normalizedStateType && second.type) {
      return normalizeTypeName(second.type) || second.type;
    }
  }
  return undefined;
}

function submittedPayloadTypeFromAliasName(
  messageIndex: Map<string, MessageCatalogEntry>,
  stateTypeName: string,
  candidateNames: string[]
): string | undefined {
  const normalizedState = normalizeIdentifier(stateTypeName);
  const candidates = [...messageIndex.values()]
    .map((message) => message.name)
    .filter((name) => normalizeIdentifier(name) !== normalizedState)
    .sort((left, right) => right.length - left.length);

  for (const name of candidateNames) {
    const normalizedName = normalizeIdentifier(stripSubmissionEnvelopeSuffixes(name));
    if (!normalizedName.includes(normalizedState)) {
      continue;
    }
    const payload = candidates.find((candidate) => {
      const normalizedPayload = normalizeIdentifier(candidate);
      return normalizedPayload && normalizedName.includes(normalizedPayload);
    });
    if (payload) {
      return normalizeTypeName(payload);
    }
  }

  return undefined;
}

function buildSubmissionEnvelopeMessage(stateTypeName: string, submittedTypeName: string): MessageCatalogEntry {
  const normalizedStateType = normalizeTypeName(stateTypeName) || "AggregateState";
  const normalizedSubmittedType = normalizeTypeName(submittedTypeName) || "SubmittedPayload";
  const name = buildSubmissionEnvelopeTypeName(normalizedSubmittedType);
  return {
    id: `message.${normalizeIdentifier(name)}`,
    name,
    fields: [
      { number: 1, name: "state", type: normalizedStateType },
      { number: 2, name: submittedPayloadFieldName(normalizedSubmittedType), type: normalizedSubmittedType }
    ]
  };
}

function buildQueryContextEnvelopeMessage(
  originalInputTypeName: string,
  queryResultTypeName: string,
  consumerStepName: string
): MessageCatalogEntry {
  const normalizedInputType = normalizeTypeName(originalInputTypeName) || "OriginalInput";
  const normalizedResultType = normalizeTypeName(queryResultTypeName) || "QueryResult";
  const name = buildQueryContextEnvelopeTypeName(consumerStepName, normalizedInputType, normalizedResultType);
  return {
    id: `message.${normalizeIdentifier(name)}`,
    name,
    fields: [
      { number: 1, name: "originalInput", type: normalizedInputType },
      { number: 2, name: "queryResult", type: normalizedResultType }
    ]
  };
}

function buildQueryContextEnvelopeTypeName(stepName: string, originalInputTypeName: string, queryResultTypeName: string): string {
  const step = normalizeTypeName(stepName);
  const validationMatch = step.match(/^Validate([A-Z][A-Za-z0-9]*)$/);
  if (validationMatch?.[1]) {
    return `${validationMatch[1]}ValidationInput`;
  }

  const originalBase = stripTypeNameSuffixes(originalInputTypeName);
  if (/\b(validate|validation)\b/i.test(stepName) && originalBase) {
    return `${originalBase}ValidationInput`;
  }

  const resultBase = stripTypeNameSuffixes(queryResultTypeName) || "QueryResult";
  return `${resultBase}Context`;
}

function buildSubmissionEnvelopeTypeName(submittedTypeName: string): string {
  const payload = stripTypeNameSuffixes(submittedTypeName) || "Submission";
  return `${payload}SubmissionContext`;
}

function stripTypeNameSuffixes(typeName: string): string {
  return normalizeTypeName(typeName).replace(/(?:SubmissionContext|Context|Submission|Command|Request|Input|Payload|Message)$/i, "");
}

function stripSubmissionEnvelopeSuffixes(typeName: string): string {
  return normalizeTypeName(typeName).replace(/(?:SubmissionContext|Context|Submission|Input)$/i, "");
}

function submittedPayloadFieldName(typeName: string): string {
  const stripped = stripTypeNameSuffixes(typeName);
  const normalized = stripped.replace(/Segment$/i, "") || stripped || normalizeTypeName(typeName) || "submission";
  return lowerCamelTypeName(normalized);
}

function isCompositeTypeName(typeName: string): boolean {
  const normalized = normalizeTypeName(typeName);
  return /\bplus\b/i.test(typeName) || /Plus/.test(normalized) || /And[A-Z]/.test(normalized);
}

function resolveCanonicalEnvelopeMessage(
  messageIndex: Map<string, MessageCatalogEntry>,
  proposed: MessageCatalogEntry,
  preferredNames: string[]
): MessageCatalogEntry {
  const proposedSignature = envelopeFieldSignature(proposed.fields);
  if (!proposedSignature) {
    return proposed;
  }

  const canonical = messageIndex.get(proposed.name);
  if (canonical && envelopeFieldSignature(canonical.fields) === proposedSignature) {
    return {
      ...canonical,
      fields: canonicalizeEnvelopeFieldNames(canonical.fields, proposed.fields)
    };
  }

  for (const name of preferredNames) {
    const existing = messageIndex.get(normalizeTypeName(name));
    if (existing && existing.name === proposed.name && envelopeFieldSignature(existing.fields) === proposedSignature) {
      return {
        ...existing,
        fields: canonicalizeEnvelopeFieldNames(existing.fields, proposed.fields)
      };
    }
  }

  return proposed;
}

function removeEquivalentEnvelopeAliases(
  messageIndex: Map<string, MessageCatalogEntry>,
  canonical: MessageCatalogEntry
): void {
  const signature = envelopeFieldSignature(canonical.fields);
  if (!signature) {
    return;
  }
  for (const [name, message] of messageIndex.entries()) {
    if (
      name !== canonical.name
      && envelopeFieldSignature(message.fields) === signature
      && isLikelyEnvelopeAliasTypeName(message.name, message.fields)
    ) {
      messageIndex.delete(name);
    }
  }
}

function removeSubmissionEnvelopeAliasNames(
  messageIndex: Map<string, MessageCatalogEntry>,
  canonicalName: string,
  submittedTypeName: string,
  candidateNames: string[]
): void {
  const normalizedCanonical = normalizeIdentifier(canonicalName);
  const normalizedSubmitted = normalizeIdentifier(submittedTypeName);
  for (const name of candidateNames) {
    const normalizedName = normalizeIdentifier(name);
    if (normalizedName && normalizedName !== normalizedCanonical && normalizedName !== normalizedSubmitted) {
      messageIndex.delete(normalizeTypeName(name));
    }
  }
}

function pruneContractQuestionsForKnownMessages(
  contractQuestions: PlannerDraft["contractQuestions"],
  messageIndex: Map<string, MessageCatalogEntry>
): void {
  const knownMessages = new Set([...messageIndex.values()].map((message) => message.name));
  for (let index = contractQuestions.length - 1; index >= 0; index -= 1) {
    if (!knownMessages.has(contractQuestions[index].messageTypeName)) {
      contractQuestions.splice(index, 1);
    }
  }
}

function envelopeFieldSignature(fields: MessageField[]): string | undefined {
  if (fields.length !== 2) {
    return undefined;
  }
  const [first, second] = fields;
  if (!first?.type || !second?.type) {
    return undefined;
  }
  return `${normalizeTypeName(first.type)}|${normalizeTypeName(second.type)}`;
}

function canonicalizeEnvelopeFieldNames(fields: MessageField[], proposedFields: MessageField[]): MessageField[] {
  return fields.map((field, index) => ({
    ...field,
    name: proposedFields[index]?.name || field.name,
    number: index + 1
  }));
}

function isLikelyEnvelopeTypeName(typeName: string): boolean {
  return /(?:Context|Input)$/i.test(typeName) || isCompositeTypeName(typeName);
}

function isLikelyEnvelopeAliasTypeName(typeName: string, fields: MessageField[]): boolean {
  if (isLikelyEnvelopeTypeName(typeName)) {
    return true;
  }
  if (fields.length !== 2) {
    return false;
  }
  const normalizedName = normalizeIdentifier(typeName);
  return fields.every((field) => normalizeIdentifier(field.type) && normalizedName.includes(normalizeIdentifier(field.type)));
}

function lowerCamelTypeName(typeName: string): string {
  const normalized = normalizeTypeName(typeName);
  if (!normalized) {
    return "value";
  }
  return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function pushEnvelopeContractQuestion(
  step: PlannerDraft["businessSteps"][number],
  envelope: MessageCatalogEntry,
  pushContractQuestion: (question: PlannerDraft["contractQuestions"][number]) => void,
  text: { prompt: string; description: string }
): void {
  const questionId = `contract.${normalizeIdentifier(step.id)}.envelope.${normalizeIdentifier(envelope.name)}`;
  pushContractQuestion({
    id: questionId,
    key: "stepContracts",
    stepId: step.id,
    stepName: step.name,
    kind: "fields",
    messageTypeName: envelope.name,
    prompt: text.prompt,
    expectedAnswerShape: {
      type: "fields",
      description: text.description
    },
    proposedAnswer: {
      questionId,
      fields: envelope.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: !field.optional,
        repeated: field.repeated
      }))
    },
    resolutionModes: ["confirm", "replace", "edit"]
  });
}

function isCompiledForwardChainStep(step: PlannerDraft["businessSteps"][number]): boolean {
  return !step.flowRole || step.flowRole === "forward" || step.kind === "query" || step.kind === "command";
}

function addProgressionProtocolConcerns(
  messages: MessageCatalogEntry[],
  businessSteps: PlannerDraft["businessSteps"],
  pushTechnicalConcern: (concern: NonNullable<PlannerDraft["technicalConcerns"]>[number]) => void
): void {
  const forwardStepIds = businessSteps.filter(isCompiledForwardChainStep).map((step) => step.id);
  if (forwardStepIds.length === 0) {
    return;
  }

  pushTechnicalConcern({
    concern: "replayability",
    appliesToSteps: forwardStepIds,
    details: "Loop-like workflow is modeled as repeatable state-advancing invocations over durable aggregate state."
  });
  pushTechnicalConcern({
    concern: "idempotency",
    appliesToSteps: forwardStepIds,
    details: "Repeated submissions of the same protocol command/input should not corrupt monotonic state progression."
  });
  pushTechnicalConcern({
    concern: "persistence",
    appliesToSteps: forwardStepIds,
    details: "Durable aggregate state is managed by persistence aspects/plugins rather than explicit save steps."
  });
  pushTechnicalConcern({
    concern: "state-transition",
    appliesToSteps: forwardStepIds,
    details: "Each invocation advances aggregate state/status monotonically toward the next required step or terminal status."
  });

  pushTechnicalConcern({
    concern: "encryption",
    appliesToSteps: forwardStepIds,
    details: "Sensitive aggregate-state fields should remain encrypted at rest across resumable protocol invocations when the brief or resolved contracts require it."
  });
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

function buildOllamaSemanticIntentPrompt(
  input: SessionStartInput,
  _profile: PlannerProfile,
  previousDraft?: PlannerDraft,
  answers?: Record<string, ContractAnswerRecord>
): PlannerPrompt {
  const revisionMode = Boolean(previousDraft || (answers && Object.keys(answers).length > 0));
  return {
    systemContent: [
      "You are the planning layer for The Pipeline Framework (TPF).",
      "Return JSON only.",
      "Extract a simple TPF pipeline intent from the brief.",
      "Loop-like workflows are modeled as replayable state-advancing invocations.",
      "The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.",
      "Use only these step kinds: internal, query, command, await.",
      "Do not model persistence as a step.",
      "When one step can complete with different business outcomes, use unions plus typed branch routing instead of a status string."
    ].join("\n"),
    userContent: [
      "Return JSON only.",
      "",
      "Use this exact shape:",
      JSON.stringify(z.toJSONSchema(semanticIntentSchema, { target: "draft-07" })),
      "",
      "Rules:",
      "- steps[].cardinality must be one of ONE_TO_ONE, EXPANSION, REDUCTION, SIDE_EFFECT",
      "- steps[].kind must be one of internal, query, command, await",
      "- when needed, unions[] defines closed outcome unions with typed variants",
      "- steps[].accepts may list only concrete contract types, never union names",
      "- if any step uses accepts, exactly one final step should set terminal=true",
      "- messages[].fields must contain only name and type",
      "- assumptions and questions must be arrays of strings",
      "- the pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state",
      "- if the brief implies staged completion, partial progress, or resume later behavior, model replayable state transitions rather than loops",
      "- each invocation should consume current aggregate state plus new input or command and return the next state or status",
      "- do not emit resume or load-state as a normal forward pipeline step",
      "",
      revisionMode ? "Revise the prior semantic intent using the resolved answers." : "Extract the semantic intent from the brief.",
      "",
      "Brief:",
      input.briefText,
      ...(previousDraft
        ? [
            "",
            "Previous planner draft:",
            JSON.stringify(previousDraft)
          ]
        : []),
      ...(answers && Object.keys(answers).length > 0
        ? [
            "",
            "Resolved answers:",
            JSON.stringify(answers)
          ]
        : [])
    ].join("\n")
  };
}

function buildPlanPrompt(input: SessionStartInput, profile: PlannerProfile): PlannerPrompt {
  const compact = profile === "compact";
  return {
    systemContent: compact ? COMPACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT,
    userContent: compact
      ? [
          "Return a TPF planner draft as JSON only.",
          "Keep it compact. Prefer concrete contracts and proposal-first contractQuestions.",
          "Preserve core TPF guardrails: no persistence steps, forward adjacency, resume outside the main flow, and await only for real suspend/resume external boundaries.",
          "Loop-like workflows are modeled as replayable state-advancing invocations.",
          "The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.",
          "When the brief implies partial completion or resume later behavior, make each forward invocation consume current aggregate state plus new input and return the next aggregate state or status.",
          "If the brief implies await behavior, use kind \"await\" with timeout, idempotencyKeyFields, and await config.",
          "If the brief implies a framework-owned read from JPA inside the pipeline, use kind \"query\" with a top-level queries entry; do not generate a fake service step.",
          "If the brief implies a replay-safe external write/effect, use kind \"command\" with command, commandIdGenerator, and optional duplicatePolicy/config; do not generate a fake service step.",
          "If one step can complete with several distinct business outcomes, model the output as a closed union in top-level unions and use the union name as outputTypeName.",
          "For union-routed branching, keep the authored pipeline linear, use accepts with concrete contract types on downstream steps, and mark exactly one final merge step with terminal: true.",
          "For JPA queries, prefer simple equality where bindings by default. Use eq/in/gt/gte/lt/lte/between/like/isNull predicates, orderBy, or limit: 1 only when the brief implies that filtering.",
          "If the brief starts from filesystem/S3/object storage input, use top-level sources plus inputBoundary.object; do not generate a fake read-file step.",
          "",
          "Brief:",
          input.briefText
        ].join("\n")
      : [
          "Produce a TPF planner draft as JSON only.",
          "Prefer proposing concrete contracts rather than asking users to define fields from scratch.",
          "When you need clarification, include contractQuestions with proposedAnswer and resolutionModes.",
          "Loop-like workflows are modeled as replayable state-advancing invocations.",
          "The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.",
          "When the brief implies staged completion, repeated submissions, retries, or resume later behavior, model commands or inputs applied to current aggregate state and return the next aggregate state or status.",
          "In the main forward-processing pipeline, step N+1 input must equal step N output unless you explicitly classify the boundary as query, resume, expansion, reduction, or merge.",
          "Never create explicit save, persist, store, or commit business steps for persistence. Persistence belongs to aspects/plugins, not business flow steps.",
          "Use query/load-state only as a boundary when current state must be rehydrated. Model resume or re-entry as a separate query/resumption surface, not a normal forward pipeline step.",
          "A framework connector query is different from a resume/read surface: use kind \"query\" only for an in-pipeline read boundary, cardinality ONE_TO_ONE, query id, optional capture.keyFields, and a top-level queries entry. In this slice, supported connector is jpa.",
          "For JPA query where clauses, use simple equality shorthand by default, for example entityId: \"input.entityId\". Use predicate objects only when the brief explicitly implies them: eq, in, gt, gte, lt, lte, between, like, or isNull. Use orderBy plus limit: 1 only for latest/top-one style reads. Do not invent database tuning or query semantics beyond the brief.",
          "Use kind \"command\" for replay-safe external writes/effects with deterministic command identity. Command steps require cardinality ONE_TO_ONE, command, commandIdGenerator, optional duplicatePolicy RETURN_RECORDED or FAIL, and optional config. Use replay-safe command/update semantics when an effect or durable state transition must be idempotent. Keep provider endpoints, credentials, and tuning outside the planner output unless the brief explicitly provides them.",
          "If one step can complete with several distinct business outcomes, model the output as a closed union in top-level unions and use the union name as the step output type.",
          "For union-routed branching, keep the pipeline linear, use accepts only with concrete contract types, and require exactly one terminal: true merge step as the last authored step.",
          "Do not use command for async callback or human approval; that is await. Do not use command for downstream ownership transfer; that is checkpoint handoff. Do not use command for ordinary internal business logic.",
          "Filesystem/S3 object ingestion is an input boundary, not a business step: use top-level sources and inputBoundary.object with emits.type/typeName/mapper. The first forward step must consume the emitted type.",
          "Use await steps only when the brief implies a real suspend/resume external boundary. Distinguish await steps from checkpoint hand-off and from ordinary forward steps.",
          "For await steps, use kind \"await\" and provide timeout, idempotencyKeyFields, and await.transport / await.correlation details. Supported await transports are interaction-api, webhook, kafka, and sqs.",
          "Checkpoint handoff is not await: model it with outputBoundary.checkpoint and, for downstream pipeline ownership, inputBoundary.subscription or compositionManifest.",
          "Use caching as an aspect or optimization recommendation, not a default business step.",
          "Record replayability, idempotency, persistence, encryption, and checkpoint hand-offs as technical concerns or optional follow-up questions when the brief implies them, rather than as graph topology.",
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
          "Preserve core TPF guardrails: no persistence steps, forward adjacency, resume outside the main flow, and await distinct from checkpoint hand-off.",
          "Loop-like workflows are modeled as replayable state-advancing invocations.",
          "The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.",
          "Keep framework connector queries as kind \"query\" steps with top-level queries definitions; keep resume/read surfaces outside the main pipeline.",
          "For JPA queries, keep equality shorthand unless the answer explicitly requires range/list/prefix/null/latest filtering.",
          "Keep replay-safe external writes as kind \"command\" steps, not fake service modules. Use command for deterministic external effects, await for callbacks/human approval, and checkpoint for downstream ownership transfer.",
          "Preserve typed union outputs, accepts routing, and one final terminal: true merge step when the brief has multiple business outcomes.",
          "Keep filesystem/S3 object ingest as top-level sources plus inputBoundary.object, not a read-file service step.",
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
          "Loop-like workflows are modeled as replayable state-advancing invocations. The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.",
          "If the brief implies staged completion, repeated submissions, retries, or resume later behavior, keep a monotonic aggregate-state progression and do not introduce backward graph edges.",
          "If the brief implies caching, replayability, idempotency, persistence, encryption, or checkpoint hand-offs, express those as aspects, technical concerns, or focused operational questions rather than as generic business steps.",
          "If the brief implies a human approval, third-party callback, or brokered external decision before the pipeline can continue, model that boundary as kind \"await\" instead of a checkpoint note or fake save step. Use sqs for SQS-brokered await behavior.",
          "If the brief implies a JPA-backed in-pipeline lookup or load-state boundary, model it as kind \"query\" with a referenced top-level queries entry when it feeds the next step, not as an internal service.",
          "For JPA lookups, preserve simple equality unless the brief or answer explicitly requires richer predicates. Use orderBy with limit: 1 only for latest/top-one reads.",
          "If the brief implies a replay-safe external write/effect or idempotent state update, model it as kind \"command\" with command, commandIdGenerator, optional duplicatePolicy, and optional config. Do not invent provider endpoint, credential, or tuning details.",
          "If the brief has multiple business outcomes with different contracts, keep a top-level unions section, use the union name as the output type, and preserve accepts plus one final terminal: true merge step.",
          "If the brief starts from filesystem/S3/object storage input, model it with top-level sources and inputBoundary.object; the first forward step consumes inputBoundary.object.emits.typeName.",
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
- Loop-like workflows are modeled as replayable state-advancing invocations.
- The pipeline execution is single-pass; the application protocol may invoke it repeatedly over durable state.
- Keep future or non-MVP items out of the active pipeline and place them in futureStepCandidates.
- Use step ids and message names consistently across the draft.
- Keep message field names unique inside each message.
- When one step can complete with several distinct business outcomes, use a closed union in top-level unions.
- Keep cardinality honest: EXPANSION for fan-out, REDUCTION for aggregate/writeout, ONE_TO_ONE otherwise.
- Treat persistence as an aspect/plugin concern. Do not emit save, persist, store, or commit business steps.
- In the main forward-processing pipeline, each step must consume the previous forward step's output type.
- When the brief implies partial completion, repeated submissions, staged progress, or resume later behavior, model commands or inputs applied to current aggregate state and return the next aggregate state or status.
- If a step is not part of the forward-processing chain, classify it explicitly with flowRole as query, resume, expansion, reduction, or merge.
- Resume and re-entry belong to a separate query/resumption surface and must not appear as normal forward pipeline steps.
- Use query/load-state boundaries only when current state must be rehydrated for the next single-pass invocation.
- Framework connector queries are different from resume/query surfaces: use kind "query" only for in-pipeline JPA reads that feed the next step. They require cardinality ONE_TO_ONE, a query id, and a matching top-level queries entry with connector "jpa", input or inputType, output or outputType, and jpa.entity / jpa.where.
- In JPA where clauses, use equality shorthand by default. Use predicate objects only when explicit filtering is implied: eq, in, gt, gte, lt, lte, between, like, isNull. Use orderBy plus limit: 1 only for latest/top-one semantics. Do not invent database tuning or hidden query behavior.
- Use kind "command" for replay-safe external writes/effects owned by the TPF command runtime. Command steps require cardinality ONE_TO_ONE, command, commandIdGenerator, optional duplicatePolicy RETURN_RECORDED or FAIL, and optional config. Use replay-safe command/update semantics when a durable state transition must be idempotent.
- For union-routed branching, keep the authored pipeline linear. Downstream routing uses accepts with concrete contract types, and exactly one final merge step must set terminal: true.
- Do not use command for async callbacks/human approval, downstream pipeline ownership transfer, or ordinary internal business logic.
- Keep provider endpoint, credential, and tuning details out of command steps unless the brief explicitly provides them; prefer runtime configuration guidance.
- Filesystem/S3 object ingestion is an input boundary: use top-level sources and inputBoundary.object with emits.type/typeName/mapper, and make the first forward step consume the emitted type.
- Distinguish ordinary forward steps, await steps, and checkpoint hand-offs.
- Use kind "await" only for suspend/resume external boundaries inside one pipeline execution.
- Do not confuse checkpoint publication with await steps.
- Await steps must declare timeout, idempotencyKeyFields, and await config with correlation and transport details.
- Await transports in this slice are interaction-api, webhook, kafka, and sqs.
- Await steps are incompatible with FUNCTION pipelines.
- Use flowBoundaryRationale when a non-forward or non-adjacent boundary is intentional.
- Treat caching as a cross-cutting optimization concern, not a default business step.
- Treat replayability, idempotency, persistence, encryption, and checkpoint hand-offs as technical concerns, aspect recommendations, or focused clarification questions when the brief implies them.
- Keep businessSteps, pipelineSteps, stepContracts, and messageCatalog mutually coherent.
`.trim();

const COMPACT_SYSTEM_PROMPT = `
You are the TPF planning layer.
Return one JSON object only.

Rules:
- proposal-first contract questions only
- no explicit save/persist/store business steps
- loop-like workflows compile into replayable state-advancing invocations
- the pipeline execution is single-pass and may be invoked repeatedly over durable state
- forward steps chain by adjacent output-to-input type
- partial progress or resume-later flows should advance aggregate state monotonically
- resume/query surfaces stay outside the main forward pipeline
- in-pipeline JPA reads use kind "query" plus a top-level queries entry; do not make a service module for them
- JPA where defaults to equality shorthand; richer predicates and orderBy/limit only when the brief asks for range/list/prefix/null/latest filtering
- replay-safe external writes use kind "command" with command, commandIdGenerator, optional duplicatePolicy/config; command is not await, checkpoint, or internal logic
- filesystem/S3 object ingest uses top-level sources plus inputBoundary.object; do not make a read-file service step
- await is distinct from checkpoint hand-off
- use kind "await" only for real suspend/resume external boundaries
- await requires timeout, idempotencyKeyFields, await.correlation.strategy, and await.transport.type
- keep businessSteps, pipelineSteps, stepContracts, and messageCatalog coherent
- include advanced concerns only when the brief implies them
`.trim();
