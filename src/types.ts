export type Transport = "GRPC" | "REST" | "LOCAL";
export type Platform = "COMPUTE" | "FUNCTION";
export type RuntimeLayout = "MODULAR" | "PIPELINE_RUNTIME" | "MONOLITH";
export type PlannerProfile = "full" | "compact";
export type PlannerProviderMode = "openai-compatible" | "ollama-native";
export type PlannerTransportMode = "auto" | "direct-http" | "mcp-sampling";
export type ToolStatus = "needs_input" | "ready" | "generated";
export type AsyncMode = "POLL_ONLY" | "CALLBACK_CAPABLE" | "SIMPLIFIED" | "UNSPECIFIED";
export type StepCardinality =
  | "ONE_TO_ONE"
  | "EXPANSION"
  | "REDUCTION"
  | "SIDE_EFFECT"
  | "MANY_TO_MANY"
  | "ONE_TO_MANY"
  | "MANY_TO_ONE";
export type StepFlowRole = "forward" | "query" | "resume" | "expansion" | "reduction" | "merge";
export type StepKind = "internal" | "delegated" | "remote" | "await" | "query";
export type AwaitCorrelationStrategy = "interactionId" | "signedResumeToken";
export type AwaitDispatchMode = "single" | "per-item";
export type AwaitTransportType = "interaction-api" | "webhook" | "kafka" | "sqs";

export type QuestionKey =
  | "businessFlow"
  | "transport"
  | "platform"
  | "runtimeLayout"
  | "stepContracts"
  | "persistence"
  | "cache"
  | "cacheInvalidation"
  | "cacheInvalidationAll"
  | "asyncMode"
  | "outputDir"
  | "basePackage";

export type ContractQuestionKind = "fields" | "type-name" | "required-fields" | "status-values";
export type AnswerResolution = "confirm" | "replace" | "edit";

export interface BriefInput {
  briefPath?: string;
  briefText?: string;
  outputDir?: string;
  appName?: string;
  basePackage?: string;
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout;
  aspects?: string[] | Record<string, boolean | AspectConfig>;
  dryRun?: boolean;
}

export interface SessionStartInput {
  briefText: string;
  appName?: string;
  basePackage?: string;
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout;
  aspects?: string[] | Record<string, boolean | AspectConfig>;
}

export interface AnswerQuestionsInput {
  sessionId: string;
  answers: ContractAnswerInput[];
}

export interface GetSessionInput {
  sessionId: string;
}

export interface GenerateSessionInput {
  sessionId: string;
}

export interface AspectConfig {
  enabled?: boolean;
  scope?: "GLOBAL" | "STEPS";
  position?: "BEFORE_STEP" | "AFTER_STEP";
  order?: number;
  config?: Record<string, unknown>;
}

export interface Question {
  id: string;
  key: QuestionKey;
  prompt: string;
  stepId?: string;
  stepName?: string;
}

export interface ContractQuestion extends Question {
  key: "stepContracts";
  kind: ContractQuestionKind;
  messageTypeName: string;
  expectedAnswerShape: ContractAnswerShape;
  proposedAnswer?: ContractAnswerRecord;
  resolutionModes?: AnswerResolution[];
}

export interface ContractAnswerShape {
  type: "fields" | "string-list";
  description: string;
}

export interface MessageField {
  number: number;
  name: string;
  type: string;
  keyType?: string;
  valueType?: string;
  repeated?: boolean;
  optional?: boolean;
}

export interface MessageDefinition {
  id?: string;
  fields: MessageField[];
}

export interface UnionVariantDefinition {
  number: number;
  type: string;
  name?: string;
}

export interface UnionDefinition {
  variants: Record<string, UnionVariantDefinition>;
}

export interface AwaitDispatchConfig {
  mode?: AwaitDispatchMode;
}

export interface AwaitCorrelationConfig {
  strategy: AwaitCorrelationStrategy;
}

export interface AwaitTransportConfig {
  type: AwaitTransportType;
  config?: Record<string, unknown>;
  request?: Record<string, unknown>;
  callback?: Record<string, unknown>;
  response?: Record<string, unknown>;
  consumer?: Record<string, unknown>;
  headers?: Record<string, string>;
  dispatch?: Record<string, unknown>;
  url?: string;
}

export interface AwaitStepConfig {
  dispatch?: AwaitDispatchConfig;
  correlation: AwaitCorrelationConfig;
  transport: AwaitTransportConfig;
}

export interface QueryCapture {
  keyFields?: string[];
}

export type JpaPredicateScalar = string | number | boolean;

export interface JpaPredicateExpression {
  eq?: JpaPredicateScalar;
  in?: JpaPredicateScalar | JpaPredicateScalar[];
  gt?: JpaPredicateScalar;
  gte?: JpaPredicateScalar;
  lt?: JpaPredicateScalar;
  lte?: JpaPredicateScalar;
  between?: [JpaPredicateScalar, JpaPredicateScalar];
  like?: JpaPredicateScalar;
  isNull?: boolean | string;
}

export type JpaWhereBinding = string | JpaPredicateExpression;

export interface JpaQueryDefinition {
  entity: string;
  where: Record<string, JpaWhereBinding>;
  projection?: Record<string, string>;
  orderBy?: Record<string, string>;
  limit?: 1;
  result?: "single";
}

export interface PipelineQueryDefinition {
  connector: "jpa";
  /** Message name or query-local input alias used by the connector definition. */
  input?: string;
  /** Pipeline message type name consumed by the query step; may be simple or fully qualified. */
  inputType?: string;
  /** Message name or query-local output alias produced by the connector definition. */
  output?: string;
  /** Pipeline message type name produced by the query step; may be simple or fully qualified. */
  outputType?: string;
  version?: string;
  jpa: JpaQueryDefinition;
}

export type ObjectSourceProvider = "filesystem" | "s3";
export type ObjectPayloadMode = "metadata" | "reference" | "text";

export interface PipelineObjectSourceFilter {
  include?: string[];
  exclude?: string[];
}

export interface PipelineObjectSourcePoll {
  enabled?: boolean;
  interval?: string;
  batchSize?: number;
}

export interface PipelineObjectSourceIdentity {
  fields?: string[];
}

export interface PipelineObjectSourcePayload {
  mode?: ObjectPayloadMode;
  refField?: string;
  maxBytes?: number;
  charset?: string;
}

export interface PipelineObjectSourceDefinition {
  kind: "object";
  provider: ObjectSourceProvider;
  location?: Record<string, unknown>;
  filter?: PipelineObjectSourceFilter;
  poll?: PipelineObjectSourcePoll;
  identity?: PipelineObjectSourceIdentity;
  payload?: PipelineObjectSourcePayload;
}

export interface PipelineStep {
  id?: string;
  name: string;
  kind?: StepKind;
  cardinality: StepCardinality;
  inputTypeName: string;
  outputTypeName: string;
  query?: string;
  capture?: QueryCapture;
  flowRole?: StepFlowRole;
  flowBoundaryRationale?: string;
  timeout?: string;
  idempotencyKeyFields?: string[];
  await?: AwaitStepConfig;
  runOnVirtualThreads?: boolean;
  parallel?: boolean;
  batchSize?: number;
  batchTimeoutMs?: number;
}

export interface CheckpointPublication {
  publication: string;
  idempotencyKeyFields?: string[];
}

export interface CheckpointSubscription {
  publication: string;
  mapper?: string;
}

export interface ObjectInputEmit {
  type: string;
  typeName?: string;
  mapper: string;
}

export interface ObjectInputBoundary {
  source?: string;
  from?: string;
  emits: ObjectInputEmit;
}

export interface PipelineInputBoundary {
  subscription?: CheckpointSubscription;
  object?: ObjectInputBoundary;
}

export interface PipelineOutputBoundary {
  checkpoint?: CheckpointPublication;
}

export interface PipelineCompositionPipeline {
  id: string;
  path: string;
}

export interface PipelineCompositionManifest {
  version: 1;
  name: string;
  pipelines: PipelineCompositionPipeline[];
}

export interface DerivedConfig {
  version: 2;
  appName: string;
  basePackage: string;
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout | LowercaseRuntimeLayout;
  input?: PipelineInputBoundary;
  output?: PipelineOutputBoundary;
  messages: Record<string, MessageDefinition>;
  unions?: Record<string, UnionDefinition>;
  queries?: Record<string, PipelineQueryDefinition>;
  sources?: Record<string, PipelineObjectSourceDefinition>;
  steps: PipelineStep[];
  aspects?: Record<string, AspectConfig>;
}

export type LowercaseRuntimeLayout = "modular" | "pipeline-runtime" | "monolith";

export interface PipelineSummary {
  title: string;
  primaryGoal: string;
  asyncMode: AsyncMode;
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout;
  selectedRuntimeLayout?: RuntimeLayout;
  runtimeLayoutAlternatives?: RuntimeLayoutAlternative[];
  outputArtifact?: string;
}

export interface RuntimeLayoutAlternative {
  layout: RuntimeLayout;
  rationale: string;
  recommendedUsage: string;
  selected: boolean;
}

export interface BusinessStep {
  id: string;
  name: string;
  purpose: string;
  kind?: StepKind;
  inputTypeName: string;
  outputTypeName: string;
  query?: string;
  capture?: QueryCapture;
  flowRole?: StepFlowRole;
  flowBoundaryRationale?: string;
  timeout?: string;
  idempotencyKeyFields?: string[];
  await?: AwaitStepConfig;
  runOnVirtualThreads?: boolean;
  inputFields: MessageField[];
  outputFields: MessageField[];
}

export interface StepContract {
  stepId: string;
  stepName: string;
  kind?: StepKind;
  inputTypeName: string;
  outputTypeName: string;
  query?: string;
  capture?: QueryCapture;
  flowRole?: StepFlowRole;
  flowBoundaryRationale?: string;
  timeout?: string;
  idempotencyKeyFields?: string[];
  await?: AwaitStepConfig;
  runOnVirtualThreads?: boolean;
  inputFields: MessageField[];
  outputFields: MessageField[];
  continuity: "coherent" | "clarification_needed";
  rationale: string;
}

export interface CouplingFinding {
  id: string;
  sourceStep: string;
  targetStep: string;
  fields: string[];
  severity: "info" | "warning";
  rationale: string;
}

export interface TechnicalConcern {
  concern:
    | "validation"
    | "persistence"
    | "encryption"
    | "state-transition"
    | "cache"
    | "replayability"
    | "idempotency"
    | "checkpoint-handoff";
  appliesToSteps: string[];
  details: string;
}

export interface MessageCatalogEntry {
  id: string;
  name: string;
  fields: MessageField[];
}

export interface ContractFieldAnswer {
  name: string;
  type: string;
  required?: boolean;
  repeated?: boolean;
  source?: "payload" | "persisted_state" | "derived";
}

export interface ContractFieldEdit {
  action: "add" | "update" | "remove";
  name: string;
  nextName?: string;
  type?: string;
  required?: boolean;
  repeated?: boolean;
  source?: "payload" | "persisted_state" | "derived";
}

export interface ContractValueEdit {
  action: "add" | "remove";
  value: string;
}

export interface ContractAnswerInput {
  questionId: string;
  resolution?: AnswerResolution;
  fields?: ContractFieldAnswer[];
  fieldEdits?: ContractFieldEdit[];
  values?: string[];
  valueEdits?: ContractValueEdit[];
}

export interface ContractAnswerRecord {
  questionId: string;
  fields?: ContractFieldAnswer[];
  values?: string[];
}

export interface PlannerDraft {
  title: string;
  primaryGoal: string;
  outputArtifact?: string;
  businessSteps: BusinessStep[];
  pipelineSteps: PipelineStep[];
  messageCatalog: MessageCatalogEntry[];
  stepContracts: StepContract[];
  contractQuestions: ContractQuestion[];
  futureStepCandidates: string[];
  assumptions: string[];
  questions?: Question[];
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout;
  aspects?: Record<string, AspectConfig>;
  inputBoundary?: PipelineInputBoundary;
  outputBoundary?: PipelineOutputBoundary;
  compositionManifest?: PipelineCompositionManifest;
  queries?: Record<string, PipelineQueryDefinition>;
  sources?: Record<string, PipelineObjectSourceDefinition>;
  technicalConcerns?: TechnicalConcern[];
  couplingFindings?: CouplingFinding[];
}

export interface AnalyzeOptions {
  contractAnswers?: Record<string, ContractAnswerRecord>;
}

export interface ArtifactReference {
  artifactId: string;
  downloadUrl?: string;
  localPath?: string;
  contentType: string;
  objectKey?: string;
  expiresAt: string;
}

export interface AnalyzeResult {
  status: ToolStatus;
  questions: Question[];
  contractQuestions: ContractQuestion[];
  assumptions: string[];
  pipelineSummary: PipelineSummary;
  businessSteps: BusinessStep[];
  stepBreakdownRationale: string[];
  futureStepCandidates: string[];
  selectedRuntimeLayout: RuntimeLayout;
  runtimeLayoutAlternatives: RuntimeLayoutAlternative[];
  messageCatalog: MessageCatalogEntry[];
  stepContracts: StepContract[];
  couplingFindings: CouplingFinding[];
  technicalConcerns: TechnicalConcern[];
  inferredMessages: MessageCatalogEntry[];
  inferredSteps: PipelineStep[];
  aspects: Record<string, AspectConfig>;
  derivedConfig: DerivedConfig;
  derivedConfigYaml: string;
  compositionManifest?: PipelineCompositionManifest;
}

export interface ScaffoldResult extends AnalyzeResult {
  generatedPath?: string;
  artifact?: ArtifactReference;
}

export interface SessionState {
  sessionId: string;
  input: SessionStartInput;
  answers: Record<string, ContractAnswerRecord>;
  plannerDraft?: PlannerDraft;
  analysis: AnalyzeResult;
  createdAt: string;
  updatedAt: string;
  generationCount: number;
  lastArtifact?: ArtifactReference;
}

export interface SessionResult extends AnalyzeResult {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  generationCount: number;
  artifact?: ArtifactReference;
}
