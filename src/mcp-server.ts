import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type {
  AnalyzeResult,
  AnswerQuestionsInput,
  BriefInput,
  GenerateSessionInput,
  GetSessionInput,
  ScaffoldResult,
  SessionResult,
  SessionStartInput
} from "./types.js";

export interface TpfMcpHandlers {
  analyzeBrief(input: BriefInput): Promise<AnalyzeResult>;
  scaffoldFromBrief(input: BriefInput): Promise<ScaffoldResult>;
  startBriefSession(input: SessionStartInput): Promise<SessionResult>;
  answerContractQuestions(input: AnswerQuestionsInput): Promise<SessionResult>;
  getBriefSession(input: GetSessionInput): Promise<SessionResult>;
  generateScaffold(input: GenerateSessionInput): Promise<SessionResult>;
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

  if (options.includeCompatibilityTools ?? true) {
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
  }

  server.registerTool(
    "start_brief_session",
    {
      description: "Start a hosted brief-analysis session and return the current business-step breakdown plus unresolved contract questions.",
      inputSchema: sessionStartSchema
    },
    async (input) => invokeTool(() => handlers.startBriefSession(input as SessionStartInput), options.errorMapper)
  );

  server.registerTool(
    "answer_contract_questions",
    {
      description: "Submit structured answers for unresolved contract questions and recompute the session analysis.",
      inputSchema: answerQuestionsSchema
    },
    async (input) => invokeTool(() => handlers.answerContractQuestions(input as AnswerQuestionsInput), options.errorMapper)
  );

  server.registerTool(
    "get_brief_session",
    {
      description: "Fetch the current state of a brief-analysis session.",
      inputSchema: sessionIdSchema
    },
    async (input) => invokeTool(() => handlers.getBriefSession(input as GetSessionInput), options.errorMapper)
  );

  server.registerTool(
    "generate_scaffold",
    {
      description: "Generate a scaffold artifact for a ready brief-analysis session.",
      inputSchema: sessionIdSchema
    },
    async (input) => invokeTool(() => handlers.generateScaffold(input as GenerateSessionInput), options.errorMapper)
  );

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
