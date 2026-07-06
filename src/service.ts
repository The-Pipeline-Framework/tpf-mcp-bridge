import path from "node:path";
import { analyzeBrief } from "./brief-analysis.js";
import { resolvePlannerToken } from "./credential-resolution.js";
import { createOpenAiPlannerClient, type PlannerClient } from "./planner-client.js";
import { BriefSessionService } from "./session-service.js";
import { generateScaffold, validateDerivedConfig } from "./template-bridge.js";
import { InMemorySessionStore, LocalFileArtifactStore } from "./storage.js";
import { WorkflowService } from "./workflow-service.js";
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
  PlannerProfile,
  PlannerProviderMode,
  ResolveContractsInput,
  ResolveContractsResult,
  ScaffoldResult,
  SessionResult,
  SessionStartInput
} from "./types.js";

let localSessionService: BriefSessionService | undefined;
let localWorkflowService: WorkflowService | undefined;
let localPlannerClient: PlannerClient | undefined;

export async function analyzeBriefTool(input: BriefInput): Promise<AnalyzeResult> {
  return analyzeBrief(input);
}

export async function inspectBriefTool(input: InspectBriefInput): Promise<InspectBriefResult> {
  return getLocalWorkflowService().inspectBrief(input);
}

export async function draftProtocolTool(input: DraftProtocolInput): Promise<DraftProtocolResult> {
  return getLocalWorkflowService().draftProtocol(input);
}

export async function draftContractsTool(input: DraftContractsInput): Promise<DraftContractsResult> {
  return getLocalWorkflowService().draftContracts(input);
}

export async function resolveContractsTool(input: ResolveContractsInput): Promise<ResolveContractsResult> {
  return getLocalWorkflowService().resolveContracts(input);
}

export async function compileScaffoldPlanTool(input: CompileScaffoldPlanInput): Promise<CompileScaffoldPlanResult> {
  return getLocalWorkflowService().compileScaffoldPlan(input);
}

export async function generateWorkflowScaffoldTool(input: GenerateScaffoldInput): Promise<GenerateScaffoldResult> {
  return getLocalWorkflowService().generateScaffold(input);
}

export async function scaffoldFromBriefTool(input: BriefInput): Promise<ScaffoldResult> {
  if (!input.outputDir) {
    throw new Error("'outputDir' is required for scaffold generation.");
  }

  const analysis = await analyzeBrief(input);
  if (analysis.status === "needs_input") {
    return analysis;
  }

  const validatedConfig = await validateDerivedConfig(analysis.derivedConfig);
  if (input.dryRun) {
    return {
      ...analysis,
      derivedConfig: validatedConfig
    };
  }

  const generatedPath = await generateScaffold(validatedConfig, input.outputDir, analysis.compositionManifest);
  return {
    ...analysis,
    status: "generated",
    derivedConfig: validatedConfig,
    generatedPath: path.resolve(generatedPath)
  };
}

export async function startBriefSessionTool(input: SessionStartInput): Promise<SessionResult> {
  return getLocalSessionService().startSession(input);
}

export async function answerContractQuestionsTool(input: AnswerQuestionsInput): Promise<SessionResult> {
  return getLocalSessionService().answerQuestions(input);
}

export async function getBriefSessionTool(input: GetSessionInput): Promise<SessionResult> {
  return getLocalSessionService().getSession(input);
}

export async function generateScaffoldSessionTool(input: GenerateSessionInput): Promise<SessionResult> {
  return getLocalSessionService().generateScaffold(input);
}

function getLocalSessionService(): BriefSessionService {
  if (!localSessionService) {
    localSessionService = new BriefSessionService(
      new InMemorySessionStore(),
      new LocalFileArtifactStore(),
      getLocalPlannerClient()
    );
  }
  return localSessionService;
}

function getLocalWorkflowService(): WorkflowService {
  if (!localWorkflowService) {
    localWorkflowService = new WorkflowService(new LocalFileArtifactStore(), createLazyLocalPlannerClient());
  }
  return localWorkflowService;
}

function createLazyLocalPlannerClient(): PlannerClient {
  return {
    async planInitialBrief(input) {
      return getLocalPlannerClient().planInitialBrief(input);
    },
    async revisePlanWithAnswers(input, previousDraft, answers) {
      return getLocalPlannerClient().revisePlanWithAnswers(input, previousDraft, answers);
    }
  };
}

function getLocalPlannerClient(): PlannerClient {
  if (!localPlannerClient) {
    localPlannerClient = createOpenAiPlannerClient({
      endpoint: requiredEnv("TPF_LLM_ENDPOINT"),
      model: requiredEnv("TPF_LLM_MODEL"),
      token: resolvePlannerToken(process.env, readPlannerProviderMode(process.env.TPF_LLM_PROVIDER_MODE)),
      profile: readPlannerProfile(process.env.TPF_LLM_PROFILE),
      providerMode: readPlannerProviderMode(process.env.TPF_LLM_PROVIDER_MODE)
    });
  }
  return localPlannerClient;
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable '${key}'. ` +
      "Set your planner configuration locally before using the local TPF session tools."
    );
  }
  return value;
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
