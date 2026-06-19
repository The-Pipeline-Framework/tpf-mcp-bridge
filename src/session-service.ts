import { materializeContractAnswer } from "./contract-answers.js";
import { assertDerivedConfigInvariants } from "./derived-config-validation.js";
import { analyzePlannerDraft } from "./planner-analysis.js";
import type { PlannerClient } from "./planner-client.js";
import { generateScaffoldZip } from "./shared-scaffold.js";
import type {
  AnalyzeResult,
  AnswerQuestionsInput,
  ContractAnswerRecord,
  GenerateSessionInput,
  GetSessionInput,
  SessionResult,
  SessionStartInput,
  SessionState
} from "./types.js";
import type { ArtifactStore, SessionStore } from "./storage.js";

export interface SessionServiceOptions {
  maxGenerationsPerSession?: number;
}

export class BriefSessionService {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly artifactStore: ArtifactStore,
    private readonly plannerClient: PlannerClient,
    private readonly options: SessionServiceOptions = {}
  ) {}

  async startSession(input: SessionStartInput): Promise<SessionResult> {
    const sessionId = crypto.randomUUID();
    const plannerDraft = await this.plannerClient.planInitialBrief(input);
    const analysis = analyzePlannerDraft(input, plannerDraft);
    const now = new Date().toISOString();
    const session: SessionState = {
      sessionId,
      input,
      answers: {},
      plannerDraft,
      analysis,
      createdAt: now,
      updatedAt: now,
      generationCount: 0
    };
    await this.sessionStore.put(session);
    return toSessionResult(session);
  }

  async answerQuestions(input: AnswerQuestionsInput): Promise<SessionResult> {
    const session = await this.requireSession(input.sessionId);
    const activeQuestions = new Map(session.analysis.contractQuestions.map((question) => [question.id, question]));
    const mergedAnswers: Record<string, ContractAnswerRecord> = { ...session.answers };
    for (const answer of input.answers) {
      const activeQuestion = activeQuestions.get(answer.questionId);
      if (!activeQuestion && !(answer.questionId in mergedAnswers)) {
        throw new Error(`Unknown or no-longer-active contract question '${answer.questionId}'.`);
      }
      if (activeQuestion) {
        mergedAnswers[answer.questionId] = materializeContractAnswer(activeQuestion, answer);
        continue;
      }
      mergedAnswers[answer.questionId] = {
        questionId: answer.questionId,
        ...(answer.fields ? { fields: answer.fields } : {}),
        ...(answer.values ? { values: answer.values } : {})
      };
    }

    const plannerDraft = await this.plannerClient.revisePlanWithAnswers(session.input, session.plannerDraft, mergedAnswers);
    const analysis = analyzePlannerDraft(session.input, plannerDraft);
    const updatedSession: SessionState = {
      ...session,
      answers: mergedAnswers,
      plannerDraft,
      analysis,
      updatedAt: new Date().toISOString()
    };
    await this.sessionStore.put(updatedSession);
    return toSessionResult(updatedSession);
  }

  async getSession(input: GetSessionInput): Promise<SessionResult> {
    return toSessionResult(await this.requireSession(input.sessionId));
  }

  async generateScaffold(input: GenerateSessionInput, options: { artifactBaseUrl?: string; artifactTtlSeconds?: number } = {}): Promise<SessionResult> {
    const session = await this.requireSession(input.sessionId);
    if (session.analysis.status === "needs_input") {
      return toSessionResult(session);
    }
    const maxGenerations = this.options.maxGenerationsPerSession ?? 3;
    if (session.generationCount >= maxGenerations) {
      throw new Error(`Session '${session.sessionId}' has reached the generation cap of ${maxGenerations}.`);
    }

    assertDerivedConfigInvariants(session.analysis.derivedConfig);
    const zipBytes = await generateScaffoldZip(session.analysis.derivedConfig, session.analysis.compositionManifest);
    const artifact = await this.artifactStore.put(session.sessionId, zipBytes, {
      ttlSeconds: options.artifactTtlSeconds,
      baseUrl: options.artifactBaseUrl
    });
    const updatedAnalysis: AnalyzeResult = {
      ...session.analysis,
      status: "generated"
    };
    const updatedSession: SessionState = {
      ...session,
      analysis: updatedAnalysis,
      generationCount: session.generationCount + 1,
      lastArtifact: artifact,
      updatedAt: new Date().toISOString()
    };
    await this.sessionStore.put(updatedSession);
    return toSessionResult(updatedSession);
  }

  private async requireSession(sessionId: string): Promise<SessionState> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session '${sessionId}'.`);
    }
    return session;
  }
}

function toSessionResult(session: SessionState): SessionResult {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    generationCount: session.generationCount,
    ...(session.lastArtifact ? { artifact: session.lastArtifact } : {}),
    ...session.analysis
  };
}
