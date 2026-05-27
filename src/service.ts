import path from "node:path";
import { analyzeBrief } from "./brief-analysis.js";
import { resolvePlannerToken } from "./credential-resolution.js";
import { createOpenAiPlannerClient } from "./planner-client.js";
import { BriefSessionService } from "./session-service.js";
import { generateScaffold, validateDerivedConfig } from "./template-bridge.js";
import { InMemorySessionStore, LocalFileArtifactStore } from "./storage.js";
import type {
  AnalyzeResult,
  AnswerQuestionsInput,
  BriefInput,
  GenerateSessionInput,
  GetSessionInput,
  PlannerProfile,
  PlannerProviderMode,
  ScaffoldResult,
  SessionResult,
  SessionStartInput
} from "./types.js";

let localSessionService: BriefSessionService | undefined;

export async function analyzeBriefTool(input: BriefInput): Promise<AnalyzeResult> {
  return analyzeBrief(input);
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

  const generatedPath = await generateScaffold(validatedConfig, input.outputDir);
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
      createOpenAiPlannerClient({
        endpoint: requiredEnv("TPF_LLM_ENDPOINT"),
        model: requiredEnv("TPF_LLM_MODEL"),
        token: resolvePlannerToken(process.env, readPlannerProviderMode(process.env.TPF_LLM_PROVIDER_MODE)),
        profile: readPlannerProfile(process.env.TPF_LLM_PROFILE),
        providerMode: readPlannerProviderMode(process.env.TPF_LLM_PROVIDER_MODE)
      })
    );
  }
  return localSessionService;
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
