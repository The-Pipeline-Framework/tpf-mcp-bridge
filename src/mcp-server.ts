import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type {
  AnalyzeResult,
  AnswerQuestionsInput,
  BriefInput,
  CompileScaffoldPlanInput,
  CompileScaffoldPlanResult,
  DraftContractsInput,
  DraftContractsResult,
  DraftProtocolInput,
  DraftProtocolResult,
  GenerateScaffoldInput,
  GenerateScaffoldResult,
  GenerateSessionInput,
  GetSessionInput,
  InspectBriefInput,
  InspectBriefResult,
  ResolveContractsInput,
  ResolveContractsResult,
  ScaffoldResult,
  SessionResult,
  SessionStartInput
} from "./types.js";

export interface TpfMcpHandlers {
  inspectBrief(input: InspectBriefInput): Promise<InspectBriefResult>;
  draftProtocol(input: DraftProtocolInput): Promise<DraftProtocolResult>;
  draftContracts(input: DraftContractsInput): Promise<DraftContractsResult>;
  resolveContracts(input: ResolveContractsInput): Promise<ResolveContractsResult>;
  compileScaffoldPlan(input: CompileScaffoldPlanInput): Promise<CompileScaffoldPlanResult>;
  generateScaffold(input: GenerateScaffoldInput): Promise<GenerateScaffoldResult>;
  analyzeBrief(input: BriefInput): Promise<AnalyzeResult>;
  scaffoldFromBrief(input: BriefInput): Promise<ScaffoldResult>;
  startBriefSession(input: SessionStartInput): Promise<SessionResult>;
  answerContractQuestions(input: AnswerQuestionsInput): Promise<SessionResult>;
  getBriefSession(input: GetSessionInput): Promise<SessionResult>;
  generateScaffoldSession(input: GenerateSessionInput): Promise<SessionResult>;
}

export interface TpfMcpServerOptions {
  includeCompatibilityTools?: boolean;
  errorMapper?: (error: unknown) => McpError;
}

const aspectHintSchema = z.union([
  z.array(z.string()),
  z.record(
    z.string(),
    z.union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        scope: z.enum(["GLOBAL", "STEPS"]).optional(),
        position: z.enum(["BEFORE_STEP", "AFTER_STEP"]).optional(),
        order: z.number().int().optional(),
        config: z.record(z.string(), z.unknown()).optional()
      })
    ])
  )
]).optional();

const detailSchema = z.enum(["summary", "full"]).optional();

const workflowBriefInputSchema = z.object({
  briefText: z.string(),
  appName: z.string().optional(),
  basePackage: z.string().optional(),
  transport: z.enum(["GRPC", "REST", "LOCAL"]).optional(),
  platform: z.enum(["COMPUTE", "FUNCTION"]).optional(),
  runtimeLayout: z.enum(["MODULAR", "PIPELINE_RUNTIME", "MONOLITH"]).optional(),
  aspects: aspectHintSchema
});

const briefInputSchema = z.object({
  briefPath: z.string().optional(),
  briefText: z.string().optional(),
  outputDir: z.string().optional(),
  appName: z.string().optional(),
  basePackage: z.string().optional(),
  transport: z.enum(["GRPC", "REST", "LOCAL"]).optional(),
  platform: z.enum(["COMPUTE", "FUNCTION"]).optional(),
  runtimeLayout: z.enum(["MODULAR", "PIPELINE_RUNTIME", "MONOLITH"]).optional(),
  aspects: aspectHintSchema,
  dryRun: z.boolean().optional()
});

const sessionStartSchema = z.object({
  briefText: z.string(),
  appName: z.string().optional(),
  basePackage: z.string().optional(),
  transport: z.enum(["GRPC", "REST", "LOCAL"]).optional(),
  platform: z.enum(["COMPUTE", "FUNCTION"]).optional(),
  runtimeLayout: z.enum(["MODULAR", "PIPELINE_RUNTIME", "MONOLITH"]).optional(),
  aspects: aspectHintSchema
});

const inspectBriefSchema = workflowBriefInputSchema.extend({
  detail: detailSchema
});

const workIdSchema = z.object({
  workId: z.string(),
  detail: detailSchema
});

const draftContractsSchema = workIdSchema.extend({
  stepIds: z.array(z.string()).optional()
});

const answerQuestionsSchema = z.object({
  sessionId: z.string(),
  answers: z.array(z.object({
    questionId: z.string(),
    resolution: z.enum(["confirm", "replace", "edit"]).optional(),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().optional(),
      repeated: z.boolean().optional(),
      source: z.enum(["payload", "persisted_state", "derived"]).optional()
    })).optional(),
    fieldEdits: z.array(z.object({
      action: z.enum(["add", "update", "remove"]),
      name: z.string(),
      nextName: z.string().optional(),
      type: z.string().optional(),
      required: z.boolean().optional(),
      repeated: z.boolean().optional(),
      source: z.enum(["payload", "persisted_state", "derived"]).optional()
    })).optional(),
    values: z.array(z.string()).optional(),
    valueEdits: z.array(z.object({
      action: z.enum(["add", "remove"]),
      value: z.string()
    })).optional()
  }))
});

const sessionIdSchema = z.object({
  sessionId: z.string()
});

export function createTpfMcpServer(
  handlers: TpfMcpHandlers,
  options: TpfMcpServerOptions = {}
): McpServer {
  const server = new McpServer({
    name: "tpf-brief-to-scaffold",
    version: "0.2.0"
  });

  server.registerTool(
    "inspect_brief",
    {
      description: "Inspect a brief, cache normalized analysis state, and return a terse workflow summary plus the next recommended tool.",
      inputSchema: inspectBriefSchema
    },
    async (input) => invokeTool(() => handlers.inspectBrief(input as InspectBriefInput), options.errorMapper)
  );

  server.registerTool(
    "draft_protocol",
    {
      description: "Draft the business protocol and explicit TPF boundaries for a cached work item without expanding full scaffold config.",
      inputSchema: workIdSchema
    },
    async (input) => invokeTool(() => handlers.draftProtocol(input as DraftProtocolInput), options.errorMapper)
  );

  server.registerTool(
    "draft_contracts",
    {
      description: "Draft scoped contracts and unresolved semantic questions for the next unresolved step/boundary batch or for explicitly requested ids.",
      inputSchema: draftContractsSchema
    },
    async (input) => invokeTool(() => handlers.draftContracts(input as DraftContractsInput), options.errorMapper)
  );

  server.registerTool(
    "resolve_contracts",
    {
      description: "Merge contract answers into the cached work state and recompute the derived scaffold plan deterministically.",
      inputSchema: z.object({
        workId: z.string(),
        answers: answerQuestionsSchema.shape.answers,
        detail: detailSchema
      })
    },
    async (input) => invokeTool(() => handlers.resolveContracts(input as ResolveContractsInput), options.errorMapper)
  );

  server.registerTool(
    "compile_scaffold_plan",
    {
      description: "Compile the cached protocol and accepted contracts into a deterministic scaffold plan summary.",
      inputSchema: workIdSchema
    },
    async (input) => invokeTool(() => handlers.compileScaffoldPlan(input as CompileScaffoldPlanInput), options.errorMapper)
  );

  server.registerTool(
    "generate_scaffold",
    {
      description: "Generate a scaffold artifact for a cached work item after the deterministic compile is ready.",
      inputSchema: workIdSchema
    },
    async (input) => invokeTool(() => handlers.generateScaffold(input as GenerateScaffoldInput), options.errorMapper)
  );

  if (options.includeCompatibilityTools ?? false) {
    server.registerTool(
      "analyze_brief",
      {
        description: "Analyze a Markdown business brief and derive a draft TPF v2 pipeline config without writing files.",
        inputSchema: briefInputSchema
      },
      async (input) => invokeTool(() => handlers.analyzeBrief(input as BriefInput), options.errorMapper)
    );

    server.registerTool(
      "scaffold_from_brief",
      {
        description: "Analyze a Markdown business brief, derive a TPF v2 pipeline config, and generate a scaffold with template-generator-node.",
        inputSchema: briefInputSchema
      },
      async (input) => invokeTool(() => handlers.scaffoldFromBrief(input as BriefInput), options.errorMapper)
    );

    server.registerTool(
      "start_brief_session",
      {
        description: "Start the legacy planner-centric brief session workflow.",
        inputSchema: sessionStartSchema
      },
      async (input) => invokeTool(() => handlers.startBriefSession(input as SessionStartInput), options.errorMapper)
    );

    server.registerTool(
      "answer_contract_questions",
      {
        description: "Submit structured answers for the legacy planner-centric session workflow.",
        inputSchema: answerQuestionsSchema
      },
      async (input) => invokeTool(() => handlers.answerContractQuestions(input as AnswerQuestionsInput), options.errorMapper)
    );

    server.registerTool(
      "get_brief_session",
      {
        description: "Fetch the current state of a legacy planner-centric brief session.",
        inputSchema: sessionIdSchema
      },
      async (input) => invokeTool(() => handlers.getBriefSession(input as GetSessionInput), options.errorMapper)
    );

    server.registerTool(
      "generate_scaffold_session",
      {
        description: "Generate a scaffold artifact for a ready legacy planner-centric brief session.",
        inputSchema: sessionIdSchema
      },
      async (input) => invokeTool(() => handlers.generateScaffoldSession(input as GenerateSessionInput), options.errorMapper)
    );
  }

  return server;
}

function toolResult(payload: unknown) {
  const structuredContent = payload as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent
  };
}

async function invokeTool(
  operation: () => Promise<unknown>,
  errorMapper?: (error: unknown) => McpError
) {
  try {
    return toolResult(await operation());
  } catch (error) {
    throw errorMapper
      ? errorMapper(error)
      : new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : String(error)
        );
  }
}
