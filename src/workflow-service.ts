import { materializeContractAnswer } from "./contract-answers.js";
import { analyzeBrief } from "./brief-analysis.js";
import { analyzePlannerDraft } from "./planner-analysis.js";
import type { PlannerClient } from "./planner-client.js";
import { validateDerivedConfig } from "./template-bridge.js";
import { generateScaffoldZip } from "./shared-scaffold.js";
import type { ArtifactStore } from "./storage.js";
import type {
  AnalyzeResult,
  ArtifactReference,
  CompileScaffoldPlanInput,
  CompileScaffoldPlanResult,
  ContractAnswerInput,
  ContractAnswerRecord,
  ContractQuestion,
  DerivedConfig,
  DetailLevel,
  DraftContractsInput,
  DraftContractsResult,
  DraftProtocolInput,
  DraftProtocolResult,
  GenerateScaffoldInput,
  GenerateScaffoldResult,
  InspectBriefInput,
  InspectBriefResult,
  MessageCatalogEntry,
  Question,
  ResolveContractsInput,
  ResolveContractsResult,
  StepContract,
  TechnicalConcern,
  ToolStatus,
  WorkState,
  WorkflowBoundary,
  WorkflowBoundaryType,
  WorkflowBriefInput,
  WorkflowConfigSummary,
  WorkflowContractScope,
  WorkflowInputSurface,
  WorkflowOutputSurface,
  WorkflowResumeSurface
} from "./types.js";

export interface WorkflowServiceOptions {
  maxGenerationsPerWork?: number;
}

export class WorkflowService {
  private readonly works = new Map<string, WorkState>();

  constructor(
    private readonly artifactStore: ArtifactStore,
    private readonly plannerClient?: PlannerClient,
    private readonly options: WorkflowServiceOptions = {}
  ) {}

  async inspectBrief(input: InspectBriefInput): Promise<InspectBriefResult> {
    const workId = crypto.randomUUID();
    const inspection = await analyzeBrief(toWorkflowBriefInput(input));
    const now = new Date().toISOString();
    const state: WorkState = {
      workId,
      input: toWorkflowBriefInput(input),
      answers: {},
      inspection,
      createdAt: now,
      updatedAt: now,
      generationCount: 0
    };
    this.works.set(workId, state);
    return toInspectBriefResult(state, normalizeDetail(input.detail));
  }

  async draftProtocol(input: DraftProtocolInput): Promise<DraftProtocolResult> {
    const state = await this.ensureProtocolDrafted(this.requireWork(input.workId));
    return toDraftProtocolResult(state, normalizeDetail(input.detail));
  }

  async draftContracts(input: DraftContractsInput): Promise<DraftContractsResult> {
    const state = this.requireWork(input.workId);
    if (!state.analysis) {
      return toUnplannedDraftContractsResult(state);
    }

    return toDraftContractsResult(state, selectScopedContracts(state, input.stepIds), normalizeDetail(input.detail));
  }

  async resolveContracts(input: ResolveContractsInput): Promise<ResolveContractsResult> {
    const state = this.requireWork(input.workId);
    if (!state.analysis || !state.plannerDraft) {
      throw new Error(`Work '${state.workId}' must run draft_protocol before resolving contracts.`);
    }

    const activeQuestions = new Map<string, Question | ContractQuestion>([
      ...state.analysis.questions.map((question) => [question.id, question] as const),
      ...state.analysis.contractQuestions.map((question) => [question.id, question] as const)
    ]);
    const mergedAnswers: Record<string, ContractAnswerRecord> = { ...state.answers };
    const updatedStepIds = new Set<string>();

    for (const answer of input.answers) {
      const activeQuestion = activeQuestions.get(answer.questionId);
      if (!activeQuestion && !(answer.questionId in mergedAnswers)) {
        throw new Error(`Unknown or no-longer-active workflow question '${answer.questionId}'.`);
      }

      if (activeQuestion) {
        mergedAnswers[answer.questionId] = isContractQuestion(activeQuestion)
          ? materializeContractAnswer(activeQuestion, answer)
          : materializeWorkflowAnswer(activeQuestion, answer);
        if (activeQuestion.stepId) {
          updatedStepIds.add(activeQuestion.stepId);
        }
        continue;
      }

      mergedAnswers[answer.questionId] = {
        questionId: answer.questionId,
        ...(answer.fields ? { fields: answer.fields } : {}),
        ...(answer.values ? { values: answer.values } : {})
      };
    }

    const plannerDraft = await this.requirePlanner().revisePlanWithAnswers(state.input, state.plannerDraft, mergedAnswers);
    const analysis = analyzePlannerDraft(state.input, plannerDraft);
    const updatedState: WorkState = {
      ...state,
      answers: mergedAnswers,
      plannerDraft,
      analysis,
      updatedAt: new Date().toISOString()
    };
    this.works.set(state.workId, updatedState);
    return toResolveContractsResult(updatedState, [...updatedStepIds], normalizeDetail(input.detail));
  }

  async compileScaffoldPlan(input: CompileScaffoldPlanInput): Promise<CompileScaffoldPlanResult> {
    const state = this.requireWork(input.workId);
    const detail = normalizeDetail(input.detail);
    if (!state.analysis) {
      return {
        status: "needs_input",
        workId: state.workId,
        ready: false,
        appName: state.inspection.derivedConfig.appName,
        basePackage: state.inspection.derivedConfig.basePackage,
        stepCount: 0,
        questionCount: 0,
        derivedConfigSummary: {
          transport: state.input.transport,
          platform: state.input.platform,
          runtimeLayout: state.input.runtimeLayout,
          stepNames: [],
          aspects: []
        },
        recommendedNextTool: "draft_protocol",
        ...(detail === "full" ? {
          validationFindings: ["Protocol has not been drafted yet."]
        } : {})
      };
    }

    const ready = state.analysis.status !== "needs_input";
    const validationFindings: string[] = [];
    let compiledConfig = state.analysis.derivedConfig;

    if (ready) {
      compiledConfig = await validateDerivedConfig(state.analysis.derivedConfig);
    } else {
      validationFindings.push(
        `${state.analysis.questions.length + state.analysis.contractQuestions.length} questions remain unresolved.`
      );
    }

    return {
      status: ready ? state.analysis.status : "needs_input",
      workId: state.workId,
      ready,
      appName: compiledConfig.appName,
      basePackage: compiledConfig.basePackage,
      stepCount: compiledConfig.steps.length,
      questionCount: state.analysis.questions.length + state.analysis.contractQuestions.length,
      derivedConfigSummary: summarizeConfig(compiledConfig),
      recommendedNextTool: ready ? "generate_scaffold" : "draft_contracts",
      ...(detail === "full" ? {
        derivedConfig: compiledConfig,
        derivedConfigYaml: state.analysis.derivedConfigYaml,
        validationFindings
      } : {})
    };
  }

  async generateScaffold(input: GenerateScaffoldInput): Promise<GenerateScaffoldResult> {
    const state = this.requireWork(input.workId);
    if (!state.analysis) {
      return {
        status: "needs_input",
        workId: state.workId
      };
    }
    if (state.analysis.status === "needs_input") {
      return {
        status: "needs_input",
        workId: state.workId,
        generatedConfigSummary: summarizeConfig(state.analysis.derivedConfig)
      };
    }

    if (state.lastArtifact) {
      return toGenerateScaffoldResult(state.lastArtifact, state);
    }

    const maxGenerations = this.options.maxGenerationsPerWork ?? 3;
    if (state.generationCount >= maxGenerations) {
      throw new Error(`Work '${state.workId}' has reached the generation cap of ${maxGenerations}.`);
    }

    const validatedConfig = await validateDerivedConfig(state.analysis.derivedConfig);
    const zipBytes = await generateScaffoldZip(validatedConfig, state.analysis.compositionManifest);
    const artifact = await this.artifactStore.put(state.workId, zipBytes);
    const updatedState: WorkState = {
      ...state,
      generationCount: state.generationCount + 1,
      lastArtifact: artifact,
      updatedAt: new Date().toISOString()
    };
    this.works.set(state.workId, updatedState);
    return toGenerateScaffoldResult(artifact, updatedState);
  }

  private requireWork(workId: string): WorkState {
    const state = this.works.get(workId);
    if (!state) {
      throw new Error(`Unknown work '${workId}'.`);
    }
    return state;
  }

  private requirePlanner(): PlannerClient {
    if (!this.plannerClient) {
      throw new Error("Workflow semantic drafting requires a configured planner client.");
    }
    return this.plannerClient;
  }

  private async ensureProtocolDrafted(state: WorkState): Promise<WorkState> {
    if (state.analysis && state.plannerDraft) {
      return state;
    }

    const plannerDraft = await this.requirePlanner().planInitialBrief(state.input);
    const analysis = analyzePlannerDraft(state.input, plannerDraft);
    const updatedState: WorkState = {
      ...state,
      plannerDraft,
      analysis,
      updatedAt: new Date().toISOString()
    };
    this.works.set(state.workId, updatedState);
    return updatedState;
  }
}

function toWorkflowBriefInput(input: InspectBriefInput): WorkflowBriefInput {
  return {
    briefText: input.briefText,
    ...(input.appName ? { appName: input.appName } : {}),
    ...(input.basePackage ? { basePackage: input.basePackage } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.runtimeLayout ? { runtimeLayout: input.runtimeLayout } : {}),
    ...(input.aspects ? { aspects: input.aspects } : {})
  };
}

function normalizeDetail(detail: DetailLevel | undefined): DetailLevel {
  return detail ?? "summary";
}

function inferWorkflowPattern(analysis: AnalyzeResult): { kind: string; rationale: string } {
  const concerns = new Set(analysis.technicalConcerns.map((concern) => concern.concern));
  const hasBoundarySemantics = analysis.inferredSteps.some((step) => step.kind === "await" || step.kind === "query")
    || Boolean(analysis.derivedConfig.input?.object || analysis.derivedConfig.input?.subscription || analysis.derivedConfig.output?.checkpoint);

  if (concerns.has("replayability") || concerns.has("state-transition") || concerns.has("persistence")) {
    return {
      kind: "progression-protocol",
      rationale: "The brief implies repeatable state advancement over durable aggregate state."
    };
  }
  if (hasBoundarySemantics) {
    return {
      kind: "boundary-oriented",
      rationale: "The brief requires explicit TPF boundaries such as await, query, checkpoint, or object input."
    };
  }
  return {
    kind: "linear-request-response",
    rationale: "The brief fits a single-pass forward pipeline without special TPF boundaries."
  };
}

function toInspectBriefResult(state: WorkState, detail: DetailLevel): InspectBriefResult {
  const pattern = inferWorkflowPattern(state.inspection);
  return {
    status: state.inspection.status,
    workId: state.workId,
    title: state.inspection.pipelineSummary.title,
    pattern: pattern.kind,
    primaryGoal: state.inspection.pipelineSummary.primaryGoal,
    detectedConcerns: uniqueConcerns(state.inspection.technicalConcerns),
    recommendedNextTool: "draft_protocol",
    ...(detail === "full" ? {
      normalizedFacts: {
        transport: state.inspection.pipelineSummary.transport,
        platform: state.inspection.pipelineSummary.platform,
        runtimeLayout: state.inspection.selectedRuntimeLayout,
        asyncMode: state.inspection.pipelineSummary.asyncMode,
        questionCount: 0,
        contractQuestionCount: 0
      },
      extractedEntities: {
        messageTypes: [],
        stepIds: [],
        aspectKeys: Object.keys(state.inspection.aspects)
      },
      inferredWorkflowPattern: pattern,
      cachedAnalysis: {
        createdAt: state.createdAt,
        updatedAt: state.updatedAt
      }
    } : {})
  };
}

function toDraftProtocolResult(state: WorkState, detail: DetailLevel): DraftProtocolResult {
  const analysis = state.analysis!;
  const protocol = inferWorkflowPattern(analysis);
  const boundaries = collectWorkflowBoundaries(analysis);
  const remainingQuestionsCount = analysis.questions.length + analysis.contractQuestions.length;
  const resumeSurface = inferResumeSurface(analysis, protocol.kind);
  const inputSurface = inferInputSurface(analysis);
  const outputSurface = inferOutputSurface(analysis);

  return {
    status: analysis.status,
    workId: state.workId,
    protocolKind: protocol.kind,
    businessSteps: analysis.businessSteps,
    boundaries,
    resumeSurface,
    inputSurface,
    outputSurface,
    technicalConcerns: analysis.technicalConcerns,
    futureStepCandidates: analysis.futureStepCandidates,
    remainingQuestionsCount,
    recommendedNextTool: remainingQuestionsCount > 0 ? "draft_contracts" : "compile_scaffold_plan",
    ...(analysis.questions.length > 0 ? { semanticQuestions: analysis.questions } : {}),
    ...(detail === "full" ? {
      stepRationales: analysis.stepBreakdownRationale,
      aggregateTransitions: analysis.businessSteps.map((step) => ({
        stepId: step.id,
        inputTypeName: step.inputTypeName,
        outputTypeName: step.outputTypeName,
        kind: step.kind,
        cardinality: state.analysis?.inferredSteps.find((candidate) => candidate.id === step.id)?.cardinality ?? "ONE_TO_ONE"
      }))
    } : {})
  };
}

function inferResumeSurface(analysis: AnalyzeResult, protocolKind: string): WorkflowResumeSurface {
  if (analysis.businessSteps.some((step) => step.flowRole === "resume")) {
    return {
      enabled: true,
      rationale: "Resume and load-state concerns are modeled as a separate surface outside the main forward pipeline."
    };
  }
  if (protocolKind === "progression-protocol") {
    return {
      enabled: true,
      mode: "load-state-before-next-invocation",
      rationale: "Repeated business interaction is modeled as fresh single-pass invocations over durable aggregate state."
    };
  }
  return {
    enabled: false,
    rationale: "The current brief does not imply a distinct resume/load-state surface."
  };
}

function inferInputSurface(analysis: AnalyzeResult): WorkflowInputSurface {
  if (analysis.derivedConfig.input?.object) {
    return {
      enabled: true,
      type: "object-input",
      rationale: "Object ingestion is modeled as an explicit TPF input boundary rather than a business step.",
      source: analysis.derivedConfig.input.object.source,
      emitsTypeName: analysis.derivedConfig.input.object.emits.typeName || analysis.derivedConfig.input.object.emits.type
    };
  }
  if (analysis.derivedConfig.input?.subscription) {
    return {
      enabled: true,
      type: "subscription",
      rationale: "Checkpoint subscription is modeled as an explicit TPF input boundary.",
      publication: analysis.derivedConfig.input.subscription.publication
    };
  }
  return {
    enabled: true,
    type: "request",
    rationale: "The protocol starts from a direct request/command input surface."
  };
}

function inferOutputSurface(analysis: AnalyzeResult): WorkflowOutputSurface {
  if (analysis.derivedConfig.output?.checkpoint) {
    return {
      enabled: true,
      type: "checkpoint",
      rationale: "Downstream ownership transfer is modeled as an output checkpoint boundary, not an await step.",
      publication: analysis.derivedConfig.output.checkpoint.publication
    };
  }
  return {
    enabled: true,
    type: "response",
    rationale: "The protocol terminates in a direct response/result surface."
  };
}

function collectWorkflowBoundaries(analysis: AnalyzeResult): WorkflowBoundary[] {
  const questionIdsByStep = new Map<string, string[]>();
  for (const question of [...analysis.questions, ...analysis.contractQuestions]) {
    if (!question.stepId) {
      continue;
    }
    const ids = questionIdsByStep.get(question.stepId) || [];
    ids.push(question.id);
    questionIdsByStep.set(question.stepId, ids);
  }

  const boundaries: WorkflowBoundary[] = [];
  for (const step of analysis.businessSteps) {
    if (step.kind !== "await" && step.kind !== "query") {
      continue;
    }
    const boundaryType = step.kind as Extract<WorkflowBoundaryType, "await" | "query">;
    boundaries.push({
      id: step.id,
      type: boundaryType,
      status: (questionIdsByStep.get(step.id)?.length ?? 0) > 0 ? "needs_input" : "resolved",
      name: step.name,
      rationale: boundaryType === "await"
        ? "Suspend/resume interaction remains an explicit await boundary in the forward pipeline."
        : "Framework-owned data loading remains an explicit query boundary in the forward pipeline.",
      stepId: step.id,
      stepName: step.name,
      inputTypeName: step.inputTypeName,
      outputTypeName: step.outputTypeName,
      timeout: step.timeout,
      transportType: step.await?.transport.type,
      correlationStrategy: step.await?.correlation.strategy,
      ...(questionIdsByStep.get(step.id)?.length ? { questionIds: questionIdsByStep.get(step.id) } : {})
    });
  }

  const objectInput = analysis.derivedConfig.input?.object;
  if (objectInput) {
    boundaries.push({
      id: `object-input:${objectInput.source || "source"}`,
      type: "object-input",
      status: "resolved",
      name: "Object Input Boundary",
      rationale: "Object ingestion is kept outside the business-step chain as an explicit input boundary.",
      source: objectInput.source,
      emitsTypeName: objectInput.emits.typeName || objectInput.emits.type
    });
  }

  const checkpoint = analysis.derivedConfig.output?.checkpoint;
  if (checkpoint) {
    boundaries.push({
      id: `checkpoint:${checkpoint.publication}`,
      type: "checkpoint",
      status: "resolved",
      name: "Output Checkpoint Boundary",
      rationale: "Downstream ownership transfer is expressed as checkpoint publication rather than a fake forward step.",
      publication: checkpoint.publication
    });
  }

  return boundaries;
}

function toDraftContractsResult(
  state: WorkState,
  scope: {
    stepIds: string[];
    stepContracts: StepContract[];
    contractQuestions: ContractQuestion[];
    semanticQuestions: Question[];
    scopedBoundaries: WorkflowBoundary[];
  },
  detail: DetailLevel
): DraftContractsResult {
  const analysis = state.analysis!;
  const remainingQuestionsCount = analysis.questions.length + analysis.contractQuestions.length;
  const hasOpenQuestions = scope.contractQuestions.length > 0 || scope.semanticQuestions.length > 0;

  return {
    status: analysis.status,
    workId: state.workId,
    scopedSteps: scope.stepContracts.map(toWorkflowContractScope),
    ...(scope.scopedBoundaries.length > 0 ? { scopedBoundaries: scope.scopedBoundaries } : {}),
    contractQuestions: scope.contractQuestions,
    ...(scope.semanticQuestions.length > 0 ? { semanticQuestions: scope.semanticQuestions } : {}),
    proposedContracts: scope.stepContracts,
    remainingQuestionsCount,
    recommendedNextTool: hasOpenQuestions ? "resolve_contracts" : "compile_scaffold_plan",
    ...(detail === "full" ? {
      proposedMessages: selectMessagesForContracts(analysis.messageCatalog, scope.stepContracts)
    } : {})
  };
}

function toUnplannedDraftContractsResult(state: WorkState): DraftContractsResult {
  return {
    status: "needs_input",
    workId: state.workId,
    scopedSteps: [],
    contractQuestions: [],
    proposedContracts: [],
    remainingQuestionsCount: 0,
    recommendedNextTool: "draft_protocol"
  };
}

function toResolveContractsResult(
  state: WorkState,
  updatedStepIds: string[],
  detail: DetailLevel
): ResolveContractsResult {
  const analysis = state.analysis!;
  const remainingQuestionsCount = analysis.questions.length + analysis.contractQuestions.length;
  const scopedContracts = updatedStepIds.length > 0
    ? analysis.stepContracts.filter((contract) => updatedStepIds.includes(contract.stepId))
    : [];

  return {
    status: analysis.status,
    workId: state.workId,
    updatedSteps: updatedStepIds,
    remainingQuestionsCount,
    recommendedNextTool: remainingQuestionsCount > 0 ? "draft_contracts" : "compile_scaffold_plan",
    ...(detail === "full" ? {
      proposedContracts: scopedContracts,
      unresolvedContractQuestions: analysis.contractQuestions,
      unresolvedSemanticQuestions: analysis.questions
    } : {})
  };
}

function toGenerateScaffoldResult(artifact: ArtifactReference, state: WorkState): GenerateScaffoldResult {
  return {
    status: "generated",
    workId: state.workId,
    artifact,
    generatedPath: artifact.localPath,
    generatedConfigSummary: summarizeConfig(state.analysis!.derivedConfig)
  };
}

function summarizeConfig(config: DerivedConfig): WorkflowConfigSummary {
  return {
    transport: config.transport,
    platform: config.platform,
    runtimeLayout: config.runtimeLayout,
    stepNames: config.steps.map((step) => step.name),
    aspects: Object.keys(config.aspects || {})
  };
}

function uniqueConcerns(concerns: TechnicalConcern[]): TechnicalConcern["concern"][] {
  return [...new Set(concerns.map((concern) => concern.concern))];
}

function selectScopedContracts(
  state: WorkState,
  requestedStepIds: string[] | undefined
): {
  stepIds: string[];
  stepContracts: StepContract[];
  contractQuestions: ContractQuestion[];
  semanticQuestions: Question[];
  scopedBoundaries: WorkflowBoundary[];
} {
  const analysis = state.analysis!;
  const boundaries = collectWorkflowBoundaries(analysis);
  const normalizedRequestedIds = (requestedStepIds || []).map((value) => value.trim()).filter(Boolean);
  const stepIds = normalizedRequestedIds.length > 0
    ? analysis.businessSteps
      .map((step) => step.id)
      .filter((stepId) => normalizedRequestedIds.includes(stepId))
    : inferNextScopedStepIds(analysis);

  const stepIdSet = new Set(stepIds);
  const scopedBoundaries = boundaries.filter((boundary) => {
    if (normalizedRequestedIds.length > 0) {
      return normalizedRequestedIds.includes(boundary.id) || (boundary.stepId ? stepIdSet.has(boundary.stepId) : false);
    }
    return boundary.stepId ? stepIdSet.has(boundary.stepId) : false;
  });
  const semanticQuestions = analysis.questions.filter((question) => {
    if (normalizedRequestedIds.length > 0) {
      return normalizedRequestedIds.includes(question.id) || (question.stepId ? stepIdSet.has(question.stepId) : false);
    }
    if (stepIdSet.size > 0) {
      return question.stepId ? stepIdSet.has(question.stepId) : false;
    }
    return !question.stepId;
  });

  return {
    stepIds,
    stepContracts: analysis.stepContracts.filter((contract) => stepIdSet.has(contract.stepId)),
    contractQuestions: analysis.contractQuestions.filter((question) => question.stepId && stepIdSet.has(question.stepId)),
    semanticQuestions,
    scopedBoundaries
  };
}

function inferNextScopedStepIds(analysis: AnalyzeResult): string[] {
  const unresolvedByQuestion = new Set(
    analysis.contractQuestions
      .map((question) => question.stepId)
      .filter((stepId): stepId is string => Boolean(stepId))
  );
  if (unresolvedByQuestion.size > 0) {
    const nextStep = analysis.businessSteps.find((step) => unresolvedByQuestion.has(step.id));
    return nextStep ? [nextStep.id] : [];
  }

  const unresolvedSemanticStep = analysis.questions.find((question) => question.stepId);
  if (unresolvedSemanticStep?.stepId) {
    return [unresolvedSemanticStep.stepId];
  }

  const needsClarification = analysis.stepContracts.find((contract) => contract.continuity === "clarification_needed");
  return needsClarification ? [needsClarification.stepId] : [];
}

function toWorkflowContractScope(contract: StepContract): WorkflowContractScope {
  const boundaryType = contract.kind === "await" || contract.kind === "query"
    ? contract.kind
    : undefined;

  return {
    targetId: contract.stepId,
    targetKind: boundaryType ? "boundary" : "step",
    ...(boundaryType ? { boundaryType } : {}),
    stepId: contract.stepId,
    stepName: contract.stepName,
    inputTypeName: contract.inputTypeName,
    outputTypeName: contract.outputTypeName,
    continuity: contract.continuity
  };
}

function selectMessagesForContracts(
  messageCatalog: MessageCatalogEntry[],
  contracts: StepContract[]
): MessageCatalogEntry[] {
  const messageNames = new Set<string>();
  for (const contract of contracts) {
    messageNames.add(contract.inputTypeName);
    messageNames.add(contract.outputTypeName);
  }
  return messageCatalog.filter((message) => messageNames.has(message.name));
}

function isContractQuestion(question: Question | ContractQuestion): question is ContractQuestion {
  return question.key === "stepContracts";
}

function materializeWorkflowAnswer(question: Question, answer: ContractAnswerInput): ContractAnswerRecord {
  if (answer.fields) {
    return {
      questionId: question.id,
      fields: answer.fields.map((field) => ({ ...field }))
    };
  }
  if (answer.values) {
    return {
      questionId: question.id,
      values: [...answer.values]
    };
  }
  throw new Error(`Workflow question '${question.id}' requires fields or values.`);
}
