import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "js-yaml";
import {
  type AnalyzeOptions,
  type AnalyzeResult,
  type AspectConfig,
  type AsyncMode,
  type BriefInput,
  type BusinessStep,
  type ContractAnswerRecord,
  type ContractFieldAnswer,
  type ContractQuestion,
  type CouplingFinding,
  type DerivedConfig,
  type MessageCatalogEntry,
  type MessageDefinition,
  type MessageField,
  type PipelineStep,
  type Platform,
  type Question,
  type RuntimeLayout,
  type RuntimeLayoutAlternative,
  type SessionStartInput,
  type StepContract,
  type TechnicalConcern,
  type ToolStatus,
  type Transport
} from "./types.js";

interface BriefContext {
  title: string;
  primaryGoal: string;
  asyncMode: AsyncMode;
  transport: Transport;
  platform: Platform;
  runtimeLayout: RuntimeLayout;
  runtimeLayoutAlternatives: RuntimeLayoutAlternative[];
  messages: Record<string, MessageDefinition>;
  steps: PipelineStep[];
  businessSteps: BusinessStep[];
  stepContracts: StepContract[];
  stepBreakdownRationale: string[];
  futureStepCandidates: string[];
  questions: Question[];
  contractQuestions: ContractQuestion[];
  assumptions: string[];
  aspects: Record<string, AspectConfig>;
  couplingFindings: CouplingFinding[];
  technicalConcerns: TechnicalConcern[];
  outputArtifact?: string;
}

interface InfrastructureDecision {
  aspects: Record<string, AspectConfig>;
  questions: Question[];
  assumptions: string[];
  technicalConcerns: TechnicalConcern[];
}

interface PlannedFlow {
  title: string;
  primaryGoal: string;
  outputArtifact?: string;
  businessSteps: BusinessStep[];
  pipelineSteps: PipelineStep[];
  pipelineMessages: Record<string, MessageDefinition>;
  stepBreakdownRationale: string[];
  futureStepCandidates: string[];
  questions: Question[];
  contractQuestions: ContractQuestion[];
  couplingFindings: CouplingFinding[];
  technicalConcerns: TechnicalConcern[];
}

interface MessageSeed {
  name: string;
  fields: MessageField[];
}

const TABLE_ROW_PATTERN = /^\|(.+)\|$/;
const NUMBERED_ITEM_PATTERN = /^\d+\.\s+(.*)$/;
const MAX_APP_NAME_TOKENS = 6;
const MAX_BASE_PACKAGE_SEGMENTS = 5;
const MAX_BASE_PACKAGE_SEGMENT_LENGTH = 20;
const MAX_BASE_PACKAGE_LENGTH = 80;
const TITLE_STOP_PATTERN = /\b(?:User Persona|Value Proposition|High-Level Requirements|Acceptance Criteria|Potential Follow-up Stories|Future Sprints|As a|Registration|State Management|Data Persistence|Resume Functionality|Data Validation|Secure Storage|AC\d+)\b/i;
const NAMING_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "backend",
  "brief",
  "by",
  "core",
  "for",
  "in",
  "incremental",
  "mvp",
  "new",
  "of",
  "on",
  "profile",
  "secure",
  "story",
  "system",
  "the",
  "to",
  "user",
  "with"
]);

const PERSONAL_INFO_FIELDS_QUESTION = "contract.personal-info.fields";
const ADDRESS_FIELDS_QUESTION = "contract.address.fields";
const SECURITY_FIELDS_QUESTION = "contract.security-credentials.fields";
const GENERIC_REQUEST_FIELDS_QUESTION = "contract.generic-request.fields";
const GENERIC_RESPONSE_FIELDS_QUESTION = "contract.generic-response.fields";

const DEFAULT_ASPECT_CONFIGS: Record<string, AspectConfig> = {
  persistence: {
    enabled: true,
    scope: "GLOBAL",
    position: "AFTER_STEP",
    order: 0,
    config: {
      pluginImplementationClass: "org.pipelineframework.plugin.persistence.PersistenceService"
    }
  },
  cache: {
    enabled: true,
    scope: "GLOBAL",
    position: "AFTER_STEP",
    order: 5,
    config: {
      pluginImplementationClass: "org.pipelineframework.plugin.cache.CacheService"
    }
  },
  "cache-invalidate": {
    enabled: true,
    scope: "STEPS",
    position: "BEFORE_STEP",
    order: -4,
    config: {
      pluginImplementationClass: "org.pipelineframework.plugin.cache.CacheInvalidationService"
    }
  },
  "cache-invalidate-all": {
    enabled: true,
    scope: "STEPS",
    position: "BEFORE_STEP",
    order: -5,
    config: {
      pluginImplementationClass: "org.pipelineframework.plugin.cache.CacheInvalidationAllService"
    }
  }
};

export async function loadBrief(input: BriefInput | SessionStartInput): Promise<{ text: string; sourceLabel: string }> {
  const typedInput = input as BriefInput;
  const hasBriefPath = Boolean(typedInput.briefPath);
  const hasBriefText = typeof input.briefText === "string" && input.briefText.trim() !== "";
  if (hasBriefPath && hasBriefText) {
    throw new Error("Provide only one of 'briefPath' or 'briefText'.");
  }
  if (!hasBriefPath && !hasBriefText) {
    throw new Error("Provide one of 'briefPath' or 'briefText'.");
  }

  if (typedInput.briefPath) {
    const resolvedPath = path.isAbsolute(typedInput.briefPath)
      ? typedInput.briefPath
      : path.resolve(process.cwd(), typedInput.briefPath);
    const text = await fs.readFile(resolvedPath, "utf8");
    return { text, sourceLabel: resolvedPath };
  }

  return { text: input.briefText!.trim(), sourceLabel: "inline brief" };
}

export async function analyzeBrief(
  input: BriefInput | SessionStartInput,
  options: AnalyzeOptions = {}
): Promise<AnalyzeResult> {
  const { text, sourceLabel } = await loadBrief(input);
  const context = buildBriefContext(sourceLabel, text, input, options.contractAnswers || {});
  const derivedConfig: DerivedConfig = {
    version: 2,
    appName: input.appName?.trim() || defaultAppName(context.title),
    basePackage: input.basePackage?.trim() || defaultBasePackage(context.title),
    transport: context.transport,
    platform: context.platform,
    runtimeLayout: runtimeLayoutToConfig(context.runtimeLayout),
    messages: Object.fromEntries(
      Object.entries(context.messages).map(([name, definition]) => [
        name,
        { fields: definition.fields }
      ])
    ),
    steps: context.steps.map(({ id, ...step }) => step),
    ...(Object.keys(context.aspects).length > 0 ? { aspects: context.aspects } : {})
  };

  if (!input.basePackage && !isLikelyJavaPackage(derivedConfig.basePackage)) {
    context.questions.push({
      id: "question.base-package",
      key: "basePackage",
      prompt: "No stable Java base package could be inferred from the brief. Provide 'basePackage' explicitly."
    });
  }

  const status: ToolStatus =
    context.questions.length > 0 || context.contractQuestions.length > 0 ? "needs_input" : "ready";

  const messageCatalog = Object.entries(context.messages).map(([name, definition]) => ({
    id: messageId(name),
    name,
    fields: definition.fields
  }));

  return {
    status,
    questions: context.questions,
    contractQuestions: context.contractQuestions,
    assumptions: context.assumptions,
    pipelineSummary: {
      title: context.title,
      primaryGoal: context.primaryGoal,
      asyncMode: context.asyncMode,
      transport: context.transport,
      platform: context.platform,
      runtimeLayout: context.runtimeLayout,
      selectedRuntimeLayout: context.runtimeLayout,
      runtimeLayoutAlternatives: context.runtimeLayoutAlternatives,
      outputArtifact: context.outputArtifact
    },
    businessSteps: context.businessSteps,
    stepBreakdownRationale: context.stepBreakdownRationale,
    futureStepCandidates: context.futureStepCandidates,
    selectedRuntimeLayout: context.runtimeLayout,
    runtimeLayoutAlternatives: context.runtimeLayoutAlternatives,
    messageCatalog,
    stepContracts: context.stepContracts,
    couplingFindings: context.couplingFindings,
    technicalConcerns: context.technicalConcerns,
    inferredMessages: messageCatalog,
    inferredSteps: context.steps,
    aspects: context.aspects,
    derivedConfig,
    derivedConfigYaml: YAML.dump(derivedConfig, { lineWidth: -1 })
  };
}

function buildBriefContext(
  sourceLabel: string,
  briefText: string,
  input: BriefInput | SessionStartInput,
  contractAnswers: Record<string, ContractAnswerRecord>
): BriefContext {
  const title = extractTitle(briefText, sourceLabel);
  const primaryGoal = inferPrimaryGoal(briefText, title);
  const transport = input.transport || inferTransport(briefText);
  const platform = input.platform || inferPlatform(briefText);
  const runtimeLayout = input.runtimeLayout || inferRuntimeLayout(briefText);
  const asyncMode = inferAsyncMode(briefText);

  const plannedFlow = planBusinessFlow(briefText, title, contractAnswers);
  const assumptions: string[] = [];
  assumptions.push(`${input.transport ? "Transport provided" : "Transport defaulted/inferred"} as ${transport}.`);
  assumptions.push(`${input.platform ? "Platform provided" : "Platform defaulted/inferred"} as ${platform}.`);
  assumptions.push(`${input.runtimeLayout ? "Runtime layout provided" : "Runtime layout defaulted/inferred"} as ${runtimeLayout}.`);
  assumptions.push(`Async provider handling inferred as ${asyncMode}.`);

  const infrastructureDecision = synthesizeInfrastructure(
    briefText,
    plannedFlow.pipelineSteps,
    plannedFlow.businessSteps,
    asyncMode,
    normalizeAspectHints(input.aspects)
  );

  assumptions.push(...infrastructureDecision.assumptions);

  const unresolvedStepIds = new Set(plannedFlow.contractQuestions.map((question) => question.stepId).filter(Boolean) as string[]);

  return {
    title,
    primaryGoal,
    asyncMode,
    transport,
    platform,
    runtimeLayout,
    runtimeLayoutAlternatives: buildRuntimeLayoutAlternatives(runtimeLayout),
    messages: plannedFlow.pipelineMessages,
    steps: plannedFlow.pipelineSteps.map((step) => ({ ...step, id: step.id || stepId(step.name) })),
    businessSteps: plannedFlow.businessSteps,
    stepContracts: plannedFlow.businessSteps.map((step) => ({
      stepId: step.id,
      stepName: step.name,
      inputTypeName: step.inputTypeName,
      outputTypeName: step.outputTypeName,
      inputFields: step.inputFields,
      outputFields: step.outputFields,
      continuity: unresolvedStepIds.has(step.id) ? "clarification_needed" : "coherent",
      rationale: plannedFlow.stepBreakdownRationale.find((entry) => entry.startsWith(`${step.name}:`)) || step.purpose
    })),
    stepBreakdownRationale: plannedFlow.stepBreakdownRationale,
    futureStepCandidates: plannedFlow.futureStepCandidates,
    questions: [...plannedFlow.questions, ...infrastructureDecision.questions],
    contractQuestions: plannedFlow.contractQuestions,
    assumptions,
    aspects: infrastructureDecision.aspects,
    couplingFindings: plannedFlow.couplingFindings,
    technicalConcerns: [...plannedFlow.technicalConcerns, ...infrastructureDecision.technicalConcerns],
    outputArtifact: plannedFlow.outputArtifact
  };
}

function planBusinessFlow(
  briefText: string,
  title: string,
  contractAnswers: Record<string, ContractAnswerRecord>
): PlannedFlow {
  const lower = briefText.toLowerCase();
  if (isOnboardingBrief(lower)) {
    return planOnboardingFlow(briefText, title, contractAnswers);
  }
  return planGenericStructuredFlow(briefText, title, contractAnswers);
}

function planOnboardingFlow(
  briefText: string,
  title: string,
  contractAnswers: Record<string, ContractAnswerRecord>
): PlannedFlow {
  const questions: Question[] = [];
  const contractQuestions: ContractQuestion[] = [];
  const futureStepCandidates = extractFutureStepCandidates(briefText);

  const personalInfoFields = selectStageFields(
    inferPersonalInfoFields(briefText),
    contractAnswers[PERSONAL_INFO_FIELDS_QUESTION]
  );
  const addressFields = selectStageFields(
    [field("addressPayload", "string")],
    contractAnswers[ADDRESS_FIELDS_QUESTION]
  );
  const securityFields = selectStageFields(
    [field("credentialPayload", "string")],
    contractAnswers[SECURITY_FIELDS_QUESTION]
  );

  const registrationRequest = messageSeed("RegistrationRequest", [
    field("email", "string", { optional: true }),
    field("mobile", "string", { optional: true }),
    field("password", "string")
  ]);
  const registrationValidated = messageSeed("RegistrationValidated", registrationRequest.fields);
  const onboardingDraftState = messageSeed("OnboardingDraftState", [
    field("userId", "uuid"),
    field("onboardingStatus", "string"),
    field("completedStage", "string", { optional: true }),
    field("email", "string", { optional: true }),
    field("mobile", "string", { optional: true })
  ]);
  const personalInfoStage = messageSeed("PersonalInfoStage", personalInfoFields);
  const personalInfoStageReady = composeMessageSeed("PersonalInfoStageReady", onboardingDraftState.fields, [
    referencedField("personalInfo", "PersonalInfoStage")
  ]);
  const personalInfoStageSaved = composeMessageSeed("PersonalInfoStageSaved", personalInfoStageReady.fields, [
    field("personalInfoSaved", "bool"),
    field("completedStage", "string")
  ]);
  const addressStage = messageSeed("AddressStage", addressFields);
  const addressStageReady = composeMessageSeed("AddressStageReady", personalInfoStageSaved.fields, [
    referencedField("address", "AddressStage")
  ]);
  const addressStageSaved = composeMessageSeed("AddressStageSaved", addressStageReady.fields, [
    field("addressSaved", "bool"),
    field("completedStage", "string")
  ]);
  const securityCredentialsStage = messageSeed("SecurityCredentialsStage", securityFields);
  const securityCredentialsStageReady = composeMessageSeed("SecurityCredentialsStageReady", addressStageSaved.fields, [
    referencedField("securityCredentials", "SecurityCredentialsStage")
  ]);
  const securityCredentialsStageSaved = composeMessageSeed("SecurityCredentialsStageSaved", securityCredentialsStageReady.fields, [
    field("securityCredentialsSaved", "bool"),
    field("completedStage", "string")
  ]);
  const onboardingResumeRequest = messageSeed("OnboardingResumeRequest", [field("userId", "uuid")]);
  const currentOnboardingState = composeMessageSeed("CurrentOnboardingState", securityCredentialsStageSaved.fields);
  const finalizationRequest = messageSeed("FinalizeOnboardingRequest", [field("userId", "uuid")]);
  const finalizedOnboardingState = composeMessageSeed("FinalizedOnboardingState", securityCredentialsStageSaved.fields, [
    field("readyForVerification", "bool")
  ]);
  const pendingVerificationAccount = messageSeed("PendingVerificationAccount", [
    field("userId", "uuid"),
    field("onboardingStatus", "string"),
    field("completedStage", "string"),
    field("readyForVerification", "bool")
  ]);

  const businessSteps: BusinessStep[] = [
    businessStep(
      "Validate Registration Input",
      "Check that the initial identifier and password are present before creating any draft account.",
      registrationRequest,
      registrationValidated
    ),
    businessStep(
      "Create Draft Account",
      "Create the initial onboarding account and assign a durable user identifier in Draft state.",
      registrationValidated,
      onboardingDraftState
    ),
    businessStep(
      "Validate Personal Info Stage",
      "Confirm the personal-information segment is usable before persisting it.",
      onboardingDraftState,
      personalInfoStageReady
    ),
    businessStep(
      "Save Personal Info Stage",
      "Persist the personal-information stage and mark that part of onboarding as completed.",
      personalInfoStageReady,
      personalInfoStageSaved
    ),
    businessStep(
      "Validate Address Stage",
      "Check the address segment before advancing to the next onboarding stage.",
      personalInfoStageSaved,
      addressStageReady
    ),
    businessStep(
      "Save Address Stage",
      "Persist the address stage and update onboarding progress.",
      addressStageReady,
      addressStageSaved
    ),
    businessStep(
      "Validate Security Credentials Stage",
      "Confirm the credential stage is acceptable before it is committed to durable state.",
      addressStageSaved,
      securityCredentialsStageReady
    ),
    businessStep(
      "Save Security Credentials Stage",
      "Persist the credential stage and keep the onboarding draft resumable.",
      securityCredentialsStageReady,
      securityCredentialsStageSaved
    ),
    businessStep(
      "Resume Onboarding State",
      "Load the latest persisted draft so the user can continue from the last completed stage.",
      onboardingResumeRequest,
      currentOnboardingState
    ),
    businessStep(
      "Finalize Onboarding",
      "Perform final completion checks across all captured onboarding segments.",
      finalizationRequest,
      finalizedOnboardingState
    ),
    businessStep(
      "Transition Status To Pending Verification",
      "Move the onboarding record from Draft to Pending Verification once required data is complete.",
      finalizedOnboardingState,
      pendingVerificationAccount
    )
  ];

  if (isGenericPayload(addressStage.fields, "addressPayload")) {
    contractQuestions.push(contractQuestion(
      ADDRESS_FIELDS_QUESTION,
      "Save Address Stage",
      "AddressStage",
      "Clarify the address fields that should be captured and validated before the address stage is saved.",
      "List the address-stage fields with names and types, for example streetLine1/string and postalCode/string."
    ));
  }
  if (isGenericPayload(securityCredentialsStage.fields, "credentialPayload")) {
    contractQuestions.push(contractQuestion(
      SECURITY_FIELDS_QUESTION,
      "Save Security Credentials Stage",
      "SecurityCredentialsStage",
      "Clarify the security-credentials fields that should be captured before the credentials stage is saved.",
      "List the credential-stage fields with names and types, for example password/string and passwordSalt/string."
    ));
  }
  if (!contractAnswers[PERSONAL_INFO_FIELDS_QUESTION] && personalInfoStage.fields.length <= 2) {
    contractQuestions.push(contractQuestion(
      PERSONAL_INFO_FIELDS_QUESTION,
      "Validate Personal Info Stage",
      "PersonalInfoStage",
      "The brief only makes the personal-info stage partially explicit. Clarify whether personal info includes additional fields beyond the inferred ones.",
      "List the personal-info fields with names and types, or confirm that the inferred fields are sufficient."
    ));
  }

  const couplingFindings = findCouplingFindings(businessSteps);
  const technicalConcerns: TechnicalConcern[] = [
    {
      concern: "validation",
      appliesToSteps: businessSteps.filter((step) => step.name.startsWith("Validate ")).map((step) => step.id),
      details: "Validation is attached to each onboarding stage rather than deferred to final submission."
    },
    {
      concern: "encryption",
      appliesToSteps: [
        stepId("Create Draft Account"),
        stepId("Save Personal Info Stage"),
        stepId("Save Address Stage"),
        stepId("Save Security Credentials Stage")
      ],
      details: "PII and credential-bearing state should be treated as encrypted-at-rest concerns across persisted onboarding stages."
    },
    {
      concern: "state-transition",
      appliesToSteps: [
        stepId("Create Draft Account"),
        stepId("Save Personal Info Stage"),
        stepId("Save Address Stage"),
        stepId("Save Security Credentials Stage"),
        stepId("Transition Status To Pending Verification")
      ],
      details: "Onboarding state advances through Draft progress markers before the final Pending Verification transition."
    }
  ];

  return {
    title,
    primaryGoal: "Create an onboarding profile over multiple resumable stages without losing progress.",
    outputArtifact: "Pending verification onboarding account",
    businessSteps,
    pipelineSteps: businessSteps
      .filter((step) => step.name !== "Resume Onboarding State")
      .map((step) => ({
        id: step.id,
        name: step.name,
        cardinality: "ONE_TO_ONE",
        inputTypeName: step.inputTypeName,
        outputTypeName: step.outputTypeName,
        parallel: false
      })),
    pipelineMessages: buildMessageCatalog([
      registrationRequest,
      registrationValidated,
      onboardingDraftState,
      personalInfoStage,
      personalInfoStageReady,
      personalInfoStageSaved,
      addressStage,
      addressStageReady,
      addressStageSaved,
      securityCredentialsStage,
      securityCredentialsStageReady,
      securityCredentialsStageSaved,
      onboardingResumeRequest,
      currentOnboardingState,
      finalizationRequest,
      finalizedOnboardingState,
      pendingVerificationAccount
    ]),
    stepBreakdownRationale: businessSteps.map((step) => `${step.name}: ${step.purpose}`),
    futureStepCandidates,
    questions,
    contractQuestions,
    couplingFindings,
    technicalConcerns
  };
}

function planGenericStructuredFlow(
  briefText: string,
  title: string,
  contractAnswers: Record<string, ContractAnswerRecord>
): PlannedFlow {
  const domain = inferDomain(briefText, title);
  const questions: Question[] = [];
  const contractQuestions: ContractQuestion[] = [];
  const requestFields = extractParameterFields(briefText, /API Call Parameters/i);
  const responseFields = extractParameterFields(briefText, /API Response/i);
  const outputColumns = extractExpectedOutputColumns(briefText);
  const outputFields = outputColumns.length > 0 ? columnsToFields(outputColumns) : responseFields;
  const usesCsvInput = /\bcsv\b/.test(briefText.toLowerCase());
  const futureStepCandidates = extractFutureStepCandidates(briefText);

  const messageSeeds: MessageSeed[] = [];
  const pipelineSteps: PipelineStep[] = [];
  const businessSteps: BusinessStep[] = [];
  const technicalConcerns: TechnicalConcern[] = [];

  const requestContract = selectStageFields(
    requestFields.length > 0 ? requestFields : defaultRequestFields(domain, briefText),
    contractAnswers[GENERIC_REQUEST_FIELDS_QUESTION]
  );
  const responseContract = selectStageFields(
    outputFields.length > 0 ? outputFields : [field("status", "string"), field("message", "string", { optional: true })],
    contractAnswers[GENERIC_RESPONSE_FIELDS_QUESTION]
  );

  if (usesCsvInput) {
    const csvFolder = messageSeed("CsvFolder", [field("path", "path")]);
    const csvInputFile = messageSeed("CsvInputFile", [field("id", "uuid"), field("path", "path")]);
    const requestMessage = messageSeed(`${domain}Request`, withImplicitId(requestContract));
    const statusMessage = messageSeed(`${domain}Status`, withImplicitId(responseContract));
    const outputMessage = messageSeed(`${domain}Output`, statusMessage.fields);
    const csvOutputFile = messageSeed("CsvOutputFile", [field("id", "uuid"), field("path", "path"), field("recordCount", "int32")]);

    messageSeeds.push(csvFolder, csvInputFile, requestMessage, statusMessage, outputMessage, csvOutputFile);
    businessSteps.push(
      businessStep("Process Input Folder", "Expand an input folder into individual CSV files for downstream processing.", csvFolder, csvInputFile),
      businessStep(`Extract ${domain} Records`, "Turn each CSV file into domain requests before the main business flow begins.", csvInputFile, requestMessage),
      businessStep(`Validate ${domain} Request`, "Check that the inbound request shape is suitable for processing.", requestMessage, requestMessage),
      businessStep(`Process ${domain} Request`, "Perform the main domain processing for each request.", requestMessage, statusMessage),
      businessStep("Write Output File", "Reduce processed records into the generated CSV output artifact.", outputMessage, csvOutputFile)
    );
    pipelineSteps.push(
      { id: stepId("Process Input Folder"), name: "Process Input Folder", cardinality: "EXPANSION", inputTypeName: "CsvFolder", outputTypeName: "CsvInputFile", parallel: false },
      { id: stepId(`Extract ${domain} Records`), name: `Extract ${domain} Records`, cardinality: "EXPANSION", inputTypeName: "CsvInputFile", outputTypeName: `${domain}Request`, parallel: false },
      { id: stepId(`Validate ${domain} Request`), name: `Validate ${domain} Request`, cardinality: "ONE_TO_ONE", inputTypeName: `${domain}Request`, outputTypeName: `${domain}Request`, parallel: false },
      { id: stepId(`Process ${domain} Request`), name: `Process ${domain} Request`, cardinality: "ONE_TO_ONE", inputTypeName: `${domain}Request`, outputTypeName: `${domain}Status`, parallel: false },
      { id: stepId("Build Output Payload"), name: "Build Output Payload", cardinality: "ONE_TO_ONE", inputTypeName: `${domain}Status`, outputTypeName: `${domain}Output`, parallel: false },
      { id: stepId("Write Output File"), name: "Write Output File", cardinality: "REDUCTION", inputTypeName: `${domain}Output`, outputTypeName: "CsvOutputFile", parallel: false, batchSize: 50, batchTimeoutMs: 1000 }
    );
  } else {
    const requestTypeName = `${domain}Request`;
    const validatedTypeName = `${domain}ValidatedRequest`;
    const resultTypeName = `${domain}Result`;
    const requestMessage = messageSeed(requestTypeName, withImplicitId(requestContract));
    const validatedMessage = messageSeed(validatedTypeName, requestMessage.fields);
    const resultMessage = messageSeed(resultTypeName, withImplicitId(responseContract));
    messageSeeds.push(requestMessage, validatedMessage, resultMessage);

    businessSteps.push(
      businessStep(`Validate ${domain} Request`, "Check that the request contains the fields needed by the backend capability.", requestMessage, validatedMessage),
      businessStep(`Process ${domain} Request`, "Execute the main business capability described by the brief.", validatedMessage, resultMessage)
    );
    pipelineSteps.push(
      { id: stepId(`Validate ${domain} Request`), name: `Validate ${domain} Request`, cardinality: "ONE_TO_ONE", inputTypeName: requestTypeName, outputTypeName: validatedTypeName, parallel: false },
      { id: stepId(`Process ${domain} Request`), name: `Process ${domain} Request`, cardinality: "ONE_TO_ONE", inputTypeName: validatedTypeName, outputTypeName: resultTypeName, parallel: false }
    );
  }

  if (requestFields.length === 0 && !contractAnswers[GENERIC_REQUEST_FIELDS_QUESTION]) {
    contractQuestions.push(contractQuestion(
      GENERIC_REQUEST_FIELDS_QUESTION,
      businessSteps[0]?.name || `Validate ${domain} Request`,
      `${domain}Request`,
      "The brief identifies the business flow, but it does not specify the request contract clearly enough to scaffold the pipeline.",
      "List the request fields with names and types that enter the pipeline."
    ));
  }
  if (responseFields.length === 0 && outputColumns.length === 0 && !contractAnswers[GENERIC_RESPONSE_FIELDS_QUESTION]) {
    contractQuestions.push(contractQuestion(
      GENERIC_RESPONSE_FIELDS_QUESTION,
      businessSteps[businessSteps.length - 1]?.name || `Process ${domain} Request`,
      `${domain}Result`,
      "The brief does not specify the result contract clearly enough to scaffold the pipeline outputs.",
      "List the response or result fields with names and types produced by the main business flow."
    ));
  }
  if (businessSteps.length === 0) {
    questions.push({
      id: "question.business-flow",
      key: "businessFlow",
      prompt: "The brief does not define enough business stages to derive a credible step breakdown."
    });
  }

  technicalConcerns.push({
    concern: "validation",
    appliesToSteps: businessSteps.filter((step) => step.name.startsWith("Validate ")).map((step) => step.id),
    details: "The primary contract check is concentrated at the request boundary before business processing."
  });

  return {
    title,
    primaryGoal: inferPrimaryGoal(briefText, title),
    outputArtifact: inferOutputArtifact(briefText, outputColumns),
    businessSteps,
    pipelineSteps,
    pipelineMessages: buildMessageCatalog(messageSeeds),
    stepBreakdownRationale: businessSteps.map((step) => `${step.name}: ${step.purpose}`),
    futureStepCandidates,
    questions,
    contractQuestions,
    couplingFindings: findCouplingFindings(businessSteps),
    technicalConcerns
  };
}

function synthesizeInfrastructure(
  briefText: string,
  pipelineSteps: PipelineStep[],
  businessSteps: BusinessStep[],
  asyncMode: AsyncMode,
  explicitAspects: Record<string, AspectConfig>
): InfrastructureDecision {
  const aspects = { ...explicitAspects };
  const questions: Question[] = [];
  const assumptions: string[] = [];
  const technicalConcerns: TechnicalConcern[] = [];
  const lower = briefText.toLowerCase();

  if (aspects.persistence) {
    assumptions.push("Persistence aspect provided explicitly.");
  } else if (shouldEnablePersistence(lower, businessSteps, asyncMode)) {
    aspects.persistence = buildAspect("persistence");
    assumptions.push("Persistence inferred from resumable or durable staged state requirements.");
  }

  if (lower.includes("encrypted") || lower.includes("secure storage") || lower.includes("pii")) {
    technicalConcerns.push({
      concern: "encryption",
      appliesToSteps: businessSteps.filter((step) => /\bcreate\b|\bsave\b|\btransition\b/i.test(step.name)).map((step) => step.id),
      details: "The brief requires secure-at-rest handling for stored user or business data."
    });
  }

  const hasAnyCacheAspect = Boolean(aspects.cache || aspects["cache-invalidate"] || aspects["cache-invalidate-all"]);
  if (hasAnyCacheAspect) {
    assumptions.push("Cache-related aspects provided explicitly.");
  } else {
    const cacheDecision = inferCacheDecision(lower, pipelineSteps);
    if (cacheDecision.enableCache) {
      aspects.cache = buildAspect("cache");
      assumptions.push("Global cache inferred for repeatable, read-heavy step work.");
    }
    if (cacheDecision.invalidationKind === "single") {
      aspects["cache-invalidate"] = buildAspect("cache-invalidate", cacheDecision.targetSteps);
      assumptions.push(`Per-item cache invalidation inferred for ${cacheDecision.targetSteps.join(", ")}.`);
    } else if (cacheDecision.invalidationKind === "all") {
      aspects["cache-invalidate-all"] = buildAspect("cache-invalidate-all", cacheDecision.targetSteps);
      assumptions.push(`Bulk cache invalidation inferred for ${cacheDecision.targetSteps.join(", ")}.`);
    } else if (cacheDecision.questionKey) {
      questions.push({
        id: `question.${cacheDecision.questionKey}`,
        key: cacheDecision.questionKey,
        prompt: cacheDecision.questionPrompt
      });
    }
  }

  return { aspects, questions, assumptions, technicalConcerns };
}

function inferTransport(briefText: string): Transport {
  const lower = briefText.toLowerCase();
  const grpcHits = countMatches(lower, /\bgrpc\b/g);
  const restHits = countMatches(lower, /\brest\b|\bhttp\b|\bbackend\b|\bapi\b/g);
  if (grpcHits >= 1 && grpcHits >= restHits) {
    return "GRPC";
  }
  if (lower.includes("in-process") || lower.includes("local only")) {
    return "LOCAL";
  }
  if (restHits > 0 || isBackendApiBrief(lower)) {
    return "REST";
  }
  return "REST";
}

function inferPlatform(briefText: string): Platform {
  const lower = briefText.toLowerCase();
  const functionScore =
    countMatches(lower, /\baws lambda\b|\blambda\b|\bazure functions\b|\bfunction urls?\b|\bserverless\b/g) * 2
    + countMatches(lower, /\bfunction handler\b|\bhttp bridge\b|\bfunctions_worker_runtime\b/g) * 2;
  return functionScore >= 2 ? "FUNCTION" : "COMPUTE";
}

function inferRuntimeLayout(briefText: string): RuntimeLayout {
  const lower = briefText.toLowerCase();
  if (/\bpipeline-runtime\b/.test(lower)) {
    return "PIPELINE_RUNTIME";
  }
  if (/\bmonolith\b/.test(lower)) {
    return "MONOLITH";
  }
  if (/\bindependently deployable\b|\bservice modules\b|\bseparate services\b|\bdeployed separately\b/.test(lower)) {
    return "MODULAR";
  }
  return "MONOLITH";
}

function inferAsyncMode(briefText: string): AsyncMode {
  const lower = briefText.toLowerCase();
  const mentionsCallback = lower.includes("callback");
  const mentionsPoll = lower.includes("poll");
  const mentionsAsync = lower.includes("asynchronous") || lower.includes("async");
  if (mentionsCallback && mentionsPoll) {
    return "CALLBACK_CAPABLE";
  }
  if (mentionsPoll) {
    return "POLL_ONLY";
  }
  if (mentionsAsync) {
    return "UNSPECIFIED";
  }
  return "SIMPLIFIED";
}

function normalizeAspectHints(hints: BriefInput["aspects"]): Record<string, AspectConfig> {
  const aspects: Record<string, AspectConfig> = {};
  if (Array.isArray(hints)) {
    for (const hint of hints) {
      aspects[hint] = buildAspect(hint);
    }
    return aspects;
  }
  if (hints && typeof hints === "object") {
    for (const [name, value] of Object.entries(hints)) {
      if (typeof value === "boolean") {
        if (value) {
          aspects[name] = buildAspect(name);
        }
        continue;
      }
      const defaultAspect = buildAspect(name);
      aspects[name] = {
        enabled: value.enabled ?? defaultAspect.enabled,
        scope: value.scope ?? defaultAspect.scope,
        position: value.position ?? defaultAspect.position,
        ...(value.order !== undefined ? { order: value.order } : defaultAspect.order !== undefined ? { order: defaultAspect.order } : {}),
        config: {
          ...(defaultAspect.config || {}),
          ...(value.config || {})
        }
      };
    }
  }
  return aspects;
}

function buildAspect(name: string, targetSteps?: string[]): AspectConfig {
  const base = DEFAULT_ASPECT_CONFIGS[name];
  if (!base) {
    return { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" };
  }
  const config = { ...(base.config || {}) };
  if (targetSteps && targetSteps.length > 0) {
    config.targetSteps = targetSteps;
  }
  return {
    enabled: base.enabled,
    scope: base.scope,
    position: base.position,
    ...(base.order !== undefined ? { order: base.order } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {})
  };
}

function inferCacheDecision(
  lower: string,
  steps: PipelineStep[]
): {
  enableCache: boolean;
  invalidationKind?: "single" | "all";
  targetSteps: string[];
  questionKey?: "cache" | "cacheInvalidation" | "cacheInvalidationAll";
  questionPrompt: string;
} {
  const cacheCueScore = countMatches(
    lower,
    /\bcache\b|\bcached\b|\breuse results\b|\bavoid re-?fetch\b|\brepeated quer(y|ies)\b|\brepeated lookup\b|\bmemoi[sz]e\b|\bread-heavy\b|\bidempotent\b/g
  );
  const replayScore = countMatches(lower, /\breplay\b|\brewind\b|\breprocess\b|\brefresh\b/g);
  const perItemScore = countMatches(lower, /\bper item\b|\bper-item\b|\bselective invalidation\b|\bchanged records?\b|\bchanged documents?\b/g);
  const bulkScore = countMatches(lower, /\brebuild\b|\breindex\b|\bclear all\b|\bfull refresh\b|\ball documents\b|\ball records\b/g);
  const targetSteps = selectCacheTargetSteps(steps);

  if (cacheCueScore === 0) {
    return { enableCache: false, targetSteps: [], questionPrompt: "" };
  }
  if (targetSteps.length === 0) {
    return {
      enableCache: false,
      targetSteps: [],
      questionKey: "cache",
      questionPrompt: "The brief suggests caching, but no clear read-like target step could be identified for safe cache synthesis."
    };
  }
  if (bulkScore > 0) {
    return { enableCache: true, invalidationKind: "all", targetSteps, questionPrompt: "" };
  }
  if (perItemScore > 0) {
    return { enableCache: true, invalidationKind: "single", targetSteps, questionPrompt: "" };
  }
  if (replayScore > 0 || hasMutableRefreshSemantics(lower)) {
    return {
      enableCache: false,
      targetSteps,
      questionKey: "cacheInvalidation",
      questionPrompt: "The brief suggests caching and replay/rebuild behavior, but it does not make the invalidation strategy clear enough to choose between per-item and bulk invalidation."
    };
  }
  return { enableCache: true, targetSteps, questionPrompt: "" };
}

function shouldEnablePersistence(lower: string, businessSteps: BusinessStep[], asyncMode: AsyncMode): boolean {
  if (lower.includes("resume") || lower.includes("draft") || lower.includes("data persistence") || lower.includes("save progress")) {
    return true;
  }
  if (businessSteps.some((step) => /\bsave\b|\bresume\b|\bdraft\b|\btransition status\b/i.test(step.name))) {
    return true;
  }
  return asyncMode !== "SIMPLIFIED" && /\bstatus tracking\b|\bdurable\b|\bretain\b/.test(lower);
}

function selectCacheTargetSteps(steps: PipelineStep[]): string[] {
  const candidates = steps
    .filter((step) => /\bresolve\b|\blookup\b|\bfetch\b|\bread\b|\benrich\b|\bextract\b/i.test(step.name))
    .map(stepToServiceClassName);
  if (candidates.length > 0) {
    return [candidates[0]];
  }
  const fallback = steps
    .filter((step) => !/write output|transition status/i.test(step.name))
    .map(stepToServiceClassName);
  return fallback.length > 0 ? [fallback[0]] : [];
}

function stepToServiceClassName(step: PipelineStep): string {
  const entityName = step.name
    .replace(/^Process\s+/i, "")
    .replace(/^Validate\s+/i, "")
    .replace(/^Enrich\s+/i, "")
    .replace(/^Transform\s+/i, "")
    .replace(/^Filter\s+/i, "")
    .replace(/^Aggregate\s+/i, "")
    .replace(/^Sort\s+/i, "")
    .trim();
  return `Process${toPascalCase(entityName)}Service`;
}

function hasMutableRefreshSemantics(lower: string): boolean {
  return /\bupdate\b|\bmutate\b|\brebuild\b|\breindex\b|\brefresh\b|\breplay\b|\brewind\b/.test(lower);
}

function buildRuntimeLayoutAlternatives(selected: RuntimeLayout): RuntimeLayoutAlternative[] {
  return [
    {
      layout: "MONOLITH",
      rationale: "Best default for a first release with the smallest operational surface area.",
      recommendedUsage: "Use when you want one deployable and minimal topology complexity.",
      selected: selected === "MONOLITH"
    },
    {
      layout: "PIPELINE_RUNTIME",
      rationale: "Useful when you want a later runtime split without fully modularizing every service.",
      recommendedUsage: "Use when one runtime host is still acceptable but pipeline runtime separation matters.",
      selected: selected === "PIPELINE_RUNTIME"
    },
    {
      layout: "MODULAR",
      rationale: "Useful when the brief or roadmap clearly points to independently deployable services.",
      recommendedUsage: "Use when separate service ownership or deployability matters more than first-release simplicity.",
      selected: selected === "MODULAR"
    }
  ];
}

function extractFutureStepCandidates(briefText: string): string[] {
  const sectionMatch = briefText.match(/(?:Potential Follow-up Stories|Future Sprints)([\s\S]*?)$/i);
  if (!sectionMatch) {
    return [];
  }
  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, ""))
    .filter(Boolean)
    .map((line) => line.replace(/\.$/, ""));
}

function extractExpectedOutputColumns(briefText: string): string[] {
  const sectionMatch = briefText.match(/##\s+Expected CSV Output Columns([\s\S]*?)(?:\n##\s+|\n#\s+|$)/i);
  if (!sectionMatch) {
    return [];
  }
  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.match(NUMBERED_ITEM_PATTERN)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function extractParameterFields(briefText: string, headingPattern: RegExp): MessageField[] {
  const rows = extractMarkdownTableRows(briefText, headingPattern);
  return rows.flatMap((row, index) => {
    const [fieldName, mandatory, typeValue] = row;
    if (!fieldName || fieldName.toLowerCase() === "field") {
      return [];
    }
    return [{
      number: index + 1,
      name: toCamelCase(fieldName),
      type: toSemanticType(fieldName, typeValue, mandatory)
    }];
  });
}

function extractMarkdownTableRows(briefText: string, headingPattern: RegExp): string[][] {
  const headingMatch = briefText.match(new RegExp(`${headingPattern.source}([\\s\\S]*?)(?:\\n##\\s+|\\n#\\s+|$)`, headingPattern.flags));
  if (!headingMatch) {
    return [];
  }
  const lines = headingMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines) {
    if (/^\|[-\s|]+\|$/.test(line)) {
      continue;
    }
    const rowMatch = line.match(TABLE_ROW_PATTERN);
    if (!rowMatch) {
      continue;
    }
    rows.push(rowMatch[1].split("|").map((cell) => cell.trim()));
  }
  return rows;
}

function inferPersonalInfoFields(briefText: string): MessageField[] {
  const lower = briefText.toLowerCase();
  const fields: MessageField[] = [];
  if (lower.includes("first name")) {
    fields.push(field("firstName", "string"));
  }
  if (lower.includes("last name")) {
    fields.push(field("lastName", "string"));
  }
  if (fields.length === 0) {
    fields.push(field("personalInfoPayload", "string"));
  }
  return fields;
}

function businessStep(name: string, purpose: string, input: MessageSeed, output: MessageSeed): BusinessStep {
  return {
    id: stepId(name),
    name,
    purpose,
    inputTypeName: input.name,
    outputTypeName: output.name,
    inputFields: input.fields,
    outputFields: output.fields
  };
}

function messageSeed(name: string, fields: MessageField[]): MessageSeed {
  return { name, fields: renumberFields(fields) };
}

function composeMessageSeed(name: string, ...fieldGroups: MessageField[][]): MessageSeed {
  return messageSeed(name, mergeMessageFields(...fieldGroups));
}

function field(name: string, type: string, options: { optional?: boolean; repeated?: boolean } = {}): MessageField {
  return {
    number: 0,
    name,
    type,
    ...(options.optional ? { optional: true } : {}),
    ...(options.repeated ? { repeated: true } : {})
  };
}

function referencedField(name: string, type: string, options: { optional?: boolean; repeated?: boolean } = {}): MessageField {
  return field(name, type, options);
}

function buildMessageCatalog(seeds: MessageSeed[]): Record<string, MessageDefinition> {
  const messages: Record<string, MessageDefinition> = {};
  for (const seed of seeds) {
    messages[seed.name] = { id: messageId(seed.name), fields: renumberFields(seed.fields) };
  }
  return messages;
}

function mergeMessageFields(...fieldGroups: MessageField[][]): MessageField[] {
  const merged: MessageField[] = [];
  const positions = new Map<string, number>();

  for (const group of fieldGroups) {
    for (const currentField of group) {
      const nextField = { ...currentField, number: 0 };
      const existingIndex = positions.get(nextField.name);
      if (existingIndex === undefined) {
        positions.set(nextField.name, merged.length);
        merged.push(nextField);
        continue;
      }
      merged[existingIndex] = { ...merged[existingIndex], ...nextField, number: 0 };
    }
  }

  return merged;
}

function renumberFields(fields: MessageField[]): MessageField[] {
  return fields.map((item, index) => ({ ...item, number: index + 1 }));
}

function findCouplingFindings(steps: BusinessStep[]): CouplingFinding[] {
  const findings: CouplingFinding[] = [];
  const producedByField = new Map<string, number>();

  steps.forEach((step, index) => {
    for (const outputField of step.outputFields) {
      if (!producedByField.has(outputField.name)) {
        producedByField.set(outputField.name, index);
      }
    }
  });

  steps.forEach((step, index) => {
    if (index < 2) {
      return;
    }
    const fields = step.inputFields
      .map((fieldValue) => fieldValue.name)
      .filter((fieldName) => {
        const sourceIndex = producedByField.get(fieldName);
        return sourceIndex !== undefined && sourceIndex < index - 1;
      });
    if (fields.length === 0) {
      return;
    }
    const sourceStepIndex = producedByField.get(fields[0]);
    if (sourceStepIndex === undefined) {
      return;
    }
    findings.push({
      id: `coupling.${steps[sourceStepIndex].id}.${step.id}`,
      sourceStep: steps[sourceStepIndex].id,
      targetStep: step.id,
      fields,
      severity: fields.length > 2 ? "warning" : "info",
      rationale: "These fields originate well before the immediately preceding step, so the contract carries non-local coupling across the flow."
    });
  });

  return findings;
}

function withImplicitId(fields: MessageField[]): MessageField[] {
  const withoutId = fields.filter((fieldValue) => fieldValue.name !== "id");
  return [field("id", "uuid"), ...withoutId];
}

function inferOutputArtifact(briefText: string, outputColumns: string[]): string | undefined {
  if (outputColumns.length > 0) {
    return "CSV output file";
  }
  const lower = briefText.toLowerCase();
  if (lower.includes("pending verification")) {
    return "Pending verification onboarding account";
  }
  if (lower.includes("output file")) {
    return "Generated output file";
  }
  return undefined;
}

function defaultRequestFields(domain: string, briefText: string): MessageField[] {
  if (domain === "Payment" && /\bcsv\b/.test(briefText.toLowerCase())) {
    return [
      field("csvId", "string"),
      field("recipient", "string"),
      field("amount", "decimal"),
      field("currency", "currency"),
      field("reference", "string", { optional: true })
    ];
  }
  return [field("payload", "string")];
}

function columnsToFields(columns: string[]): MessageField[] {
  return columns.map((column) => field(toCamelCase(column), toSemanticType(column, inferTypeFromColumn(column), "O")));
}

function inferTypeFromColumn(column: string): string {
  const lower = column.toLowerCase();
  if (lower.includes("amount") || lower.includes("fee")) {
    return "decimal";
  }
  if (lower.includes("currency")) {
    return "currency";
  }
  if (lower.includes("id")) {
    return "string";
  }
  return "string";
}

function toSemanticType(fieldName: string, typeValue: string | undefined, mandatory: string | undefined): string {
  const normalizedType = String(typeValue || "").trim().toLowerCase();
  const normalizedField = fieldName.trim().toLowerCase();
  if (normalizedField.endsWith("id") || normalizedField === "conversationid" || normalizedField === "userid") {
    return "uuid";
  }
  if (normalizedType.includes("decimal")) {
    return "decimal";
  }
  if (normalizedType.includes("bool")) {
    return "bool";
  }
  if (normalizedType.includes("int") || normalizedType.includes("long")) {
    return "int64";
  }
  if (normalizedType.includes("url") || normalizedField === "url") {
    return "uri";
  }
  if (normalizedType.includes("currency")) {
    return "currency";
  }
  if (normalizedType.includes("date") || normalizedType.includes("time")) {
    return "timestamp";
  }
  if (normalizedField.includes("path") || normalizedField.includes("file")) {
    return "path";
  }
  if (mandatory?.trim().toUpperCase() === "O") {
    return "string";
  }
  return "string";
}

function extractTitle(briefText: string, sourceLabel: string): string {
  const headingMatch = briefText.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  const storyTitle = extractLabeledSegment(briefText, "Story Title");
  if (storyTitle) {
    return storyTitle;
  }
  const userStoryTitle = extractLabeledSegment(briefText, "User Story");
  if (userStoryTitle) {
    return userStoryTitle;
  }
  const firstSentence = extractFirstSentence(briefText);
  if (firstSentence) {
    return firstSentence;
  }
  const base = path.basename(sourceLabel, path.extname(sourceLabel));
  if (base.toLowerCase() === "inline brief") {
    return "";
  }
  return toTitleCase(base.replace(/[-_]+/g, " "));
}

function inferDomain(briefText: string, title: string): string {
  const lower = briefText.toLowerCase();
  if (lower.includes("payment")) {
    return "Payment";
  }
  if (lower.includes("onboarding")) {
    return "Onboarding";
  }
  if (lower.includes("customer")) {
    return "Customer";
  }
  if (lower.includes("order")) {
    return "Order";
  }
  if (lower.includes("document")) {
    return "Document";
  }
  const significant = title
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .find((part) => !["csv", "processing", "application", "pipeline", "system", "backend"].includes(part.toLowerCase()));
  return significant ? toPascalCase(significant) : "Business";
}

function inferPrimaryGoal(briefText: string, title: string): string {
  const asAUserStory = briefText.match(/As a [^,]+,\s*I want to\s+([^,]+),\s*So that\s+([^\n.]+)/i);
  if (asAUserStory) {
    return `${capitalize(asAUserStory[1].trim())} so that ${asAUserStory[2].trim()}`;
  }
  const motivationMatch = briefText.match(/##\s+Motivation([\s\S]*?)(?:\n##\s+|\n#\s+|$)/i);
  if (motivationMatch) {
    const sentence = motivationMatch[1]
      .split(/\n+/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (sentence) {
      return sentence.replace(/\.$/, "");
    }
  }
  return `Generate a TPF scaffold for ${title}`;
}

function defaultAppName(title: string): string {
  const tokens = namingTokens(title, MAX_APP_NAME_TOKENS);
  if (tokens.length === 0) {
    return "PipelineApplication";
  }
  return toPascalCase(tokens.join(" "));
}

function defaultBasePackage(title: string): string {
  const tokens = namingTokens(title, MAX_BASE_PACKAGE_SEGMENTS)
    .map((token) => token.slice(0, MAX_BASE_PACKAGE_SEGMENT_LENGTH));
  if (tokens.length === 0) {
    return "";
  }
  const packageName = `com.example.${tokens.join(".")}`.slice(0, MAX_BASE_PACKAGE_LENGTH).replace(/\.+$/g, "");
  return packageName;
}

function isLikelyJavaPackage(value: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(value);
}

function extractLabeledSegment(briefText: string, label: string): string | undefined {
  const labelPattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*`, "i");
  const match = labelPattern.exec(briefText);
  if (!match) {
    return undefined;
  }

  const remainder = briefText.slice(match.index + match[0].length);
  const stopIndex = findTitleStopIndex(remainder);
  const candidate = remainder.slice(0, stopIndex).trim().replace(/\s+/g, " ");
  return candidate || undefined;
}

function findTitleStopIndex(value: string): number {
  const newlineIndex = value.search(/\n\s*\n|\r\n\s*\r\n/);
  const titleStopMatch = TITLE_STOP_PATTERN.exec(value);
  const indices = [newlineIndex, titleStopMatch?.index ?? -1].filter((index) => index >= 0);
  if (indices.length === 0) {
    return value.length;
  }
  return Math.min(...indices);
}

function extractFirstSentence(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const sentence = normalized.split(/(?<=[.!?])\s+/)[0]?.trim();
  return sentence || undefined;
}

function namingTokens(title: string, limit: number): string[] {
  const rawTokens = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const tokens = rawTokens.filter((token) => !isNamingStopWord(token));
  const stableTokens = (tokens.length > 0 ? tokens : rawTokens)
    .filter((token) => /^[a-z0-9]+$/.test(token))
    .slice(0, limit);

  return stableTokens;
}

function isNamingStopWord(token: string): boolean {
  return NAMING_STOP_WORDS.has(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeLayoutToConfig(layout: RuntimeLayout): "modular" | "pipeline-runtime" | "monolith" {
  switch (layout) {
    case "MODULAR":
      return "modular";
    case "PIPELINE_RUNTIME":
      return "pipeline-runtime";
    case "MONOLITH":
      return "monolith";
  }
}

function isOnboardingBrief(lower: string): boolean {
  return lower.includes("onboarding") || lower.includes("draft account") || lower.includes("pending verification");
}

function isBackendApiBrief(lower: string): boolean {
  return /\bbackend\b|\bapi\b|\buser story\b|\bregister\b|\bform\b|\bonboarding\b/.test(lower);
}

function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function toCamelCase(value: string): string {
  if (/^[a-z][A-Za-z0-9]*$/.test(value)) {
    return value.charAt(0).toLowerCase() + value.slice(1);
  }
  const pascal = toPascalCase(value);
  return pascal.length === 0 ? "field" : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function countMatches(input: string, pattern: RegExp): number {
  return input.match(pattern)?.length ?? 0;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function stepId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function messageId(name: string): string {
  return `message.${name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}`;
}

function selectStageFields(
  inferredFields: MessageField[],
  answer?: ContractAnswerRecord
): MessageField[] {
  if (!answer?.fields || answer.fields.length === 0) {
    return inferredFields;
  }
  return answer.fields.map(answerFieldToMessageField);
}

function answerFieldToMessageField(answer: ContractFieldAnswer, index = 0): MessageField {
  return {
    number: index + 1,
    name: toCamelCase(answer.name),
    type: answer.type,
    ...(answer.required === false ? { optional: true } : {}),
    ...(answer.repeated ? { repeated: true } : {})
  };
}

function contractQuestion(
  id: string,
  stepName: string,
  messageTypeName: string,
  prompt: string,
  description: string
): ContractQuestion {
  return {
    id,
    key: "stepContracts",
    stepId: stepId(stepName),
    stepName,
    kind: "fields",
    messageTypeName,
    prompt,
    expectedAnswerShape: {
      type: "fields",
      description
    }
  };
}

function isGenericPayload(fields: MessageField[], fieldName: string): boolean {
  return fields.length === 1 && fields[0].name === fieldName;
}
