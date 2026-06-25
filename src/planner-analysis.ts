import YAML from "js-yaml";
import type {
  AnalyzeResult,
  AspectConfig,
  BriefInput,
  BusinessStep,
  ContractQuestion,
  CouplingFinding,
  DerivedConfig,
  MessageCatalogEntry,
  MessageDefinition,
  MessageField,
  PipelineObjectSourceDefinition,
  PipelineCompositionManifest,
  PipelineInputBoundary,
  PipelineOutputBoundary,
  PipelineQueryDefinition,
  PlannerDraft,
  PipelineStep,
  Question,
  RuntimeLayout,
  RuntimeLayoutAlternative,
  SessionStartInput,
  StepFlowRole,
  StepKind,
  StepContract
} from "./types.js";
import { legacyObjectInputBoundary, simpleTypeName, typeNamesMatch } from "./type-name-utils.js";

export function analyzePlannerDraft(
  input: BriefInput | SessionStartInput,
  draft: PlannerDraft
): AnalyzeResult {
  const title = draft.title.trim();
  const transport = input.transport || draft.transport || "REST";
  const platform = input.platform || draft.platform || "COMPUTE";
  const runtimeLayout = input.runtimeLayout || draft.runtimeLayout || "MONOLITH";
  const appName = input.appName?.trim() || defaultAppName(title);
  const basePackage = input.basePackage?.trim() || defaultBasePackage(title);

  const messageCatalog = normalizeMessageCatalog(draft.messageCatalog);
  const messages = Object.fromEntries(
    messageCatalog.map((message) => [
      message.name,
      { fields: message.fields } satisfies MessageDefinition
    ])
  );
  const businessSteps = normalizeBusinessSteps(draft.businessSteps, messages);
  const stepContracts = normalizeStepContracts(draft.stepContracts, businessSteps, messages);
  const inferredSteps = normalizePipelineSteps(draft.pipelineSteps);
  const inputBoundary = normalizeInputBoundary(draft.inputBoundary);
  const outputBoundary = normalizeOutputBoundary(draft.outputBoundary);
  const compositionManifest = normalizeCompositionManifest(draft.compositionManifest);
  const queries = normalizeQueries(draft.queries);
  const sources = normalizeObjectSources(draft.sources);
  const explicitQuestions = normalizeQuestions(draft.questions || []);
  const contractQuestions = normalizeContractQuestions(draft.contractQuestions);
  const questions = [...explicitQuestions];
  const resolvedAspects = resolveAspects(input.aspects, draft.aspects) || {};
  const hasAwaitSteps = inferredSteps.some((step) => normalizeStepKind(step.kind) === "await");

  if (!input.basePackage && !isLikelyJavaPackage(basePackage)) {
    questions.push({
      id: "question.base-package",
      key: "basePackage",
      prompt: "No stable Java base package could be inferred from the brief. Provide 'basePackage' explicitly."
    });
  }

  const derivedConfig: DerivedConfig = {
    version: 2,
    appName,
    basePackage,
    transport,
    platform,
    runtimeLayout: runtimeLayoutToConfig(runtimeLayout),
    ...(inputBoundary ? { input: inputBoundary } : {}),
    ...(outputBoundary ? { output: outputBoundary } : {}),
    messages,
    ...(Object.keys(queries).length > 0 ? { queries } : {}),
    ...(Object.keys(sources).length > 0 ? { sources } : {}),
    steps: inferredSteps.map(({ id, ...step }) => step),
    ...(Object.keys(resolvedAspects).length > 0 ? { aspects: resolvedAspects } : {})
  };

  assertPlannerSemantics(businessSteps, stepContracts, inferredSteps, queries, sources, resolvedAspects, platform, inputBoundary, outputBoundary, compositionManifest);

  const couplingFindings = draft.couplingFindings?.length ? draft.couplingFindings : deriveCouplingFindings(businessSteps);
  const status = questions.length > 0 || contractQuestions.length > 0 ? "needs_input" : "ready";

  return {
    status,
    questions,
    contractQuestions,
    assumptions: draft.assumptions,
    pipelineSummary: {
      title,
      primaryGoal: draft.primaryGoal,
      asyncMode: hasAwaitSteps ? "CALLBACK_CAPABLE" : "UNSPECIFIED",
      transport,
      platform,
      runtimeLayout,
      selectedRuntimeLayout: runtimeLayout,
      runtimeLayoutAlternatives: buildRuntimeLayoutAlternatives(runtimeLayout),
      outputArtifact: draft.outputArtifact
    },
    businessSteps,
    stepBreakdownRationale: businessSteps.map((step) => `${step.name}: ${step.purpose}`),
    futureStepCandidates: draft.futureStepCandidates,
    selectedRuntimeLayout: runtimeLayout,
    runtimeLayoutAlternatives: buildRuntimeLayoutAlternatives(runtimeLayout),
    messageCatalog,
    stepContracts,
    couplingFindings,
    technicalConcerns: draft.technicalConcerns || [],
    inferredMessages: messageCatalog,
    inferredSteps,
    aspects: resolvedAspects,
    derivedConfig,
    derivedConfigYaml: YAML.dump(derivedConfig, { lineWidth: -1 }),
    ...(compositionManifest ? { compositionManifest } : {})
  };
}

function normalizeMessageCatalog(messages: MessageCatalogEntry[]): MessageCatalogEntry[] {
  const seen = new Set<string>();
  return messages.map((message) => {
    if (seen.has(message.name)) {
      throw new Error(`Planner draft defines duplicate message '${message.name}'.`);
    }
    seen.add(message.name);
    return {
      id: message.id || `message.${message.name.toLowerCase()}`,
      name: message.name,
      fields: renumberFields(message.fields)
    };
  });
}

function normalizeBusinessSteps(
  steps: BusinessStep[],
  messages: Record<string, MessageDefinition>
): BusinessStep[] {
  const seen = new Set<string>();
  return steps.map((step) => {
    const id = step.id || stepId(step.name);
    if (seen.has(id)) {
      throw new Error(`Planner draft defines duplicate business step '${id}'.`);
    }
    seen.add(id);
    const inputFields = step.inputFields.length > 0 ? renumberFields(step.inputFields) : messages[step.inputTypeName]?.fields || [];
    const outputFields = step.outputFields.length > 0 ? renumberFields(step.outputFields) : messages[step.outputTypeName]?.fields || [];
    return {
      ...step,
      id,
      kind: normalizeStepKind(step.kind),
      ...(normalizeQueryId(step.query) ? { query: normalizeQueryId(step.query) } : {}),
      ...(normalizeQueryCapture(step.capture) ? { capture: normalizeQueryCapture(step.capture) } : {}),
      timeout: step.timeout?.trim() || undefined,
      idempotencyKeyFields: normalizeIdempotencyKeyFields(step.idempotencyKeyFields),
      await: normalizeAwaitConfig(step.await),
      inputFields,
      outputFields
    };
  });
}

function normalizeStepContracts(
  contracts: StepContract[],
  steps: BusinessStep[],
  messages: Record<string, MessageDefinition>
): StepContract[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  return contracts.map((contract) => {
    const step = stepById.get(contract.stepId);
    if (!step) {
      throw new Error(`Planner draft references unknown step contract '${contract.stepId}'.`);
    }
    return {
      ...contract,
      kind: normalizeStepKind(contract.kind),
      ...(normalizeQueryId(contract.query) ? { query: normalizeQueryId(contract.query) } : {}),
      ...(normalizeQueryCapture(contract.capture) ? { capture: normalizeQueryCapture(contract.capture) } : {}),
      timeout: contract.timeout?.trim() || undefined,
      idempotencyKeyFields: normalizeIdempotencyKeyFields(contract.idempotencyKeyFields),
      await: normalizeAwaitConfig(contract.await),
      inputFields: contract.inputFields.length > 0 ? renumberFields(contract.inputFields) : messages[contract.inputTypeName]?.fields || step.inputFields,
      outputFields: contract.outputFields.length > 0 ? renumberFields(contract.outputFields) : messages[contract.outputTypeName]?.fields || step.outputFields,
      continuity: contract.continuity || "coherent"
    };
  });
}

function normalizePipelineSteps(steps: AnalyzeResult["inferredSteps"]): AnalyzeResult["inferredSteps"] {
  const seen = new Set<string>();
  return steps.map((step) => {
    const id = step.id || stepId(step.name);
    if (seen.has(id)) {
      throw new Error(`Planner draft defines duplicate pipeline step '${id}'.`);
    }
    seen.add(id);
    return {
      ...step,
      id,
      kind: normalizeStepKind(step.kind),
      ...(normalizeQueryId(step.query) ? { query: normalizeQueryId(step.query) } : {}),
      ...(normalizeQueryCapture(step.capture) ? { capture: normalizeQueryCapture(step.capture) } : {}),
      timeout: step.timeout?.trim() || undefined,
      idempotencyKeyFields: normalizeIdempotencyKeyFields(step.idempotencyKeyFields),
      await: normalizeAwaitConfig(step.await)
    };
  });
}

function normalizeInputBoundary(boundary: PipelineInputBoundary | undefined): PipelineInputBoundary | undefined {
  const subscriptionPublication = boundary?.subscription?.publication?.trim();
  const objectBoundary = normalizeObjectInputBoundary(boundary?.object || legacyObjectInputBoundary(boundary));
  if (!subscriptionPublication && !objectBoundary) {
    return undefined;
  }
  return {
    ...(subscriptionPublication
      ? {
          subscription: {
            publication: subscriptionPublication,
            ...(boundary?.subscription?.mapper?.trim() ? { mapper: boundary.subscription.mapper.trim() } : {})
          }
        }
      : {}),
    ...(objectBoundary ? { object: objectBoundary } : {})
  };
}

function normalizeObjectInputBoundary(boundary: PipelineInputBoundary["object"] | undefined): PipelineInputBoundary["object"] | undefined {
  const source = boundary?.source?.trim() || boundary?.from?.trim();
  const emits = boundary?.emits;
  if (!source || !emits?.type?.trim() || !emits?.mapper?.trim()) {
    return undefined;
  }
  return {
    source,
    emits: {
      type: emits.type.trim(),
      ...(emits.typeName?.trim() ? { typeName: emits.typeName.trim() } : {}),
      mapper: emits.mapper.trim()
    }
  };
}

function normalizeOutputBoundary(boundary: PipelineOutputBoundary | undefined): PipelineOutputBoundary | undefined {
  if (!boundary?.checkpoint?.publication?.trim()) {
    return undefined;
  }
  return {
    checkpoint: {
      publication: boundary.checkpoint.publication.trim(),
      ...(boundary.checkpoint.idempotencyKeyFields?.length
        ? { idempotencyKeyFields: normalizeIdempotencyKeyFields(boundary.checkpoint.idempotencyKeyFields) }
        : {})
    }
  };
}

function normalizeCompositionManifest(manifest: PipelineCompositionManifest | undefined): PipelineCompositionManifest | undefined {
  if (!manifest) {
    return undefined;
  }
  const name = manifest.name?.trim();
  if (!name) {
    throw new Error("Planner draft compositionManifest must include a non-empty name.");
  }
  if (!Array.isArray(manifest.pipelines) || manifest.pipelines.length === 0) {
    throw new Error("Planner draft compositionManifest must include at least one pipeline.");
  }
  const pipelines = manifest.pipelines.map((pipeline, index) => {
    const id = pipeline.id?.trim();
    const path = pipeline.path?.trim();
    if (!id) {
      throw new Error(`Planner draft compositionManifest pipeline at index ${index} must include a non-empty id.`);
    }
    if (!path) {
      throw new Error(`Planner draft compositionManifest pipeline '${id}' must include a non-empty path.`);
    }
    return { id, path };
  });
  return {
    version: 1,
    name,
    pipelines
  };
}

function normalizeQueries(
  queries: Record<string, PipelineQueryDefinition> | undefined
): Record<string, PipelineQueryDefinition> {
  if (!queries || typeof queries !== "object") {
    return {};
  }
  const normalizedQueries: Record<string, PipelineQueryDefinition> = {};
  for (const [id, query] of Object.entries(queries)) {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new Error("Planner draft defines a query with an empty id.");
    }
    if (normalizedQueries[normalizedId]) {
      throw new Error(`Planner draft defines duplicate query '${normalizedId}' after trimming ids.`);
    }
    const inputType = query.inputType?.trim();
    const input = query.input?.trim();
    const outputType = query.outputType?.trim();
    const output = query.output?.trim();
    if (!inputType && !input) {
      throw new Error(`Planner draft query '${normalizedId}' must include inputType or input.`);
    }
    if (!outputType && !output) {
      throw new Error(`Planner draft query '${normalizedId}' must include outputType or output.`);
    }
    if (!query.jpa) {
      throw new Error(`Planner draft query '${normalizedId}' must include jpa configuration.`);
    }
    const entity = query.jpa.entity?.trim();
    if (!entity) {
      throw new Error(`Planner draft query '${normalizedId}' must include jpa.entity.`);
    }
    normalizedQueries[normalizedId] = {
      connector: "jpa",
      ...(inputType ? { inputType } : input ? { input } : {}),
      ...(outputType ? { outputType } : output ? { output } : {}),
      ...(query.version?.trim() ? { version: query.version.trim() } : { version: "v1" }),
      jpa: {
        entity,
        where: normalizeJpaWhere(query.jpa.where, normalizedId),
        ...(query.jpa.projection ? { projection: normalizeStringMap(query.jpa.projection) } : {}),
        ...(query.jpa.orderBy ? { orderBy: normalizeJpaOrderBy(query.jpa.orderBy, normalizedId) } : {}),
        ...(query.jpa.limit !== undefined ? { limit: normalizeJpaLimit(query.jpa.limit, query.jpa.orderBy, normalizedId) } : {}),
        ...(query.jpa.result ? { result: query.jpa.result } : {})
      }
    };
  }
  return normalizedQueries;
}

function normalizeObjectSources(
  sources: Record<string, PipelineObjectSourceDefinition> | undefined
): Record<string, PipelineObjectSourceDefinition> {
  if (!sources || typeof sources !== "object") {
    return {};
  }
  const normalizedSources: Record<string, PipelineObjectSourceDefinition> = {};
  for (const [id, source] of Object.entries(sources)) {
    const normalizedId = id.trim();
    if (!normalizedId) {
      throw new Error("Planner draft defines an object source with an empty id.");
    }
    if (normalizedSources[normalizedId]) {
      throw new Error(`Planner draft defines duplicate object source '${normalizedId}' after trimming ids.`);
    }
    const provider = source.provider?.trim() as PipelineObjectSourceDefinition["provider"] | undefined;
    if (!provider) {
      throw new Error(`Planner draft object source '${normalizedId}' must include provider.`);
    }
    normalizedSources[normalizedId] = {
      kind: "object",
      provider,
      ...(source.location ? { location: source.location } : {}),
      ...(source.filter ? { filter: normalizeObjectSourceFilter(source.filter) } : {}),
      ...(source.poll ? { poll: normalizeObjectSourcePoll(source.poll) } : {}),
      ...(source.identity?.fields?.length
        ? { identity: { fields: [...new Set(source.identity.fields.map((field) => field.trim()).filter(Boolean))] } }
        : {}),
      ...(source.payload ? { payload: normalizeObjectSourcePayload(source.payload) } : {})
    };
  }
  return normalizedSources;
}

function normalizeObjectSourceFilter(filter: PipelineObjectSourceDefinition["filter"]): PipelineObjectSourceDefinition["filter"] {
  return {
    ...(filter?.include?.length ? { include: filter.include.map((value) => value.trim()).filter(Boolean) } : {}),
    ...(filter?.exclude?.length ? { exclude: filter.exclude.map((value) => value.trim()).filter(Boolean) } : {})
  };
}

function normalizeObjectSourcePoll(poll: PipelineObjectSourceDefinition["poll"]): PipelineObjectSourceDefinition["poll"] {
  return {
    ...(typeof poll?.enabled === "boolean" ? { enabled: poll.enabled } : {}),
    ...(poll?.interval?.trim() ? { interval: poll.interval.trim() } : {}),
    ...(typeof poll?.batchSize === "number" ? { batchSize: poll.batchSize } : {})
  };
}

function normalizeObjectSourcePayload(payload: PipelineObjectSourceDefinition["payload"]): PipelineObjectSourceDefinition["payload"] {
  return {
    ...(payload?.mode ? { mode: payload.mode } : {}),
    ...(payload?.refField?.trim() ? { refField: payload.refField.trim() } : {}),
    ...(typeof payload?.maxBytes === "number" ? { maxBytes: payload.maxBytes } : {}),
    ...(payload?.charset?.trim() ? { charset: payload.charset.trim() } : {})
  };
}

function normalizeStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value || {})
    .map(([key, item]) => [key.trim(), item.trim()])
    .filter(([key, item]) => Boolean(key && item)));
}

function normalizeJpaWhere(
  value: PipelineQueryDefinition["jpa"]["where"],
  queryId: string
): PipelineQueryDefinition["jpa"]["where"] {
  const entries = Object.entries(value || {});
  if (entries.length === 0) {
    throw new Error(`Planner draft query '${queryId}' must include at least one jpa.where binding.`);
  }
  return Object.fromEntries(entries.map(([key, item]) => {
    const field = key.trim();
    if (!field) {
      throw new Error(`Planner draft query '${queryId}' has an empty jpa.where field.`);
    }
    if (typeof item === "string") {
      const expression = item.trim();
      if (!expression) {
        throw new Error(`Planner draft query '${queryId}' has an empty jpa.where binding for '${field}'.`);
      }
      return [field, expression];
    }
    return [field, normalizeJpaPredicate(item, queryId, field)];
  }));
}

function normalizeJpaPredicate(
  value: Exclude<PipelineQueryDefinition["jpa"]["where"][string], string>,
  queryId: string,
  field: string
): Exclude<PipelineQueryDefinition["jpa"]["where"][string], string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Planner draft query '${queryId}' has an invalid jpa.where predicate for '${field}'.`);
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (entries.length !== 1) {
    throw new Error(`Planner draft query '${queryId}' jpa.where predicate for '${field}' must declare exactly one operator.`);
  }
  const [operator, raw] = entries[0]!;
  switch (operator) {
    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "like":
      return { [operator]: normalizeJpaScalar(raw, queryId, field, operator) };
    case "in":
      if (Array.isArray(raw)) {
        if (raw.length === 0) {
          throw new Error(`Planner draft query '${queryId}' jpa.where '${field}.in' must not be empty.`);
        }
        return { in: raw.map((item) => normalizeJpaScalar(item, queryId, field, operator)) };
      }
      return { in: normalizeJpaScalar(raw, queryId, field, operator) };
    case "between":
      if (!Array.isArray(raw) || raw.length !== 2) {
        throw new Error(`Planner draft query '${queryId}' jpa.where '${field}.between' must include exactly two values.`);
      }
      return {
        between: [
          normalizeJpaScalar(raw[0], queryId, field, operator),
          normalizeJpaScalar(raw[1], queryId, field, operator)
        ]
      };
    case "isNull":
      if (typeof raw === "boolean") {
        return { isNull: raw };
      }
      if (typeof raw === "string" && /^(true|false)$/i.test(raw.trim())) {
        return { isNull: raw.trim().toLowerCase() === "true" };
      }
      throw new Error(`Planner draft query '${queryId}' jpa.where '${field}.isNull' must be boolean or boolean-like string.`);
    default:
      throw new Error(`Planner draft query '${queryId}' jpa.where '${field}' uses unsupported predicate operator '${operator}'.`);
  }
}

function normalizeJpaScalar(
  value: unknown,
  queryId: string,
  field: string,
  operator: string
): string | number | boolean {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Planner draft query '${queryId}' jpa.where '${field}.${operator}' must not be blank.`);
    }
    return normalized;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Planner draft query '${queryId}' jpa.where '${field}.${operator}' must be a string, number, or boolean.`);
}

function normalizeJpaOrderBy(
  value: NonNullable<PipelineQueryDefinition["jpa"]["orderBy"]>,
  queryId: string
): Record<string, string> {
  const entries = Object.entries(value || {});
  if (entries.length === 0) {
    throw new Error(`Planner draft query '${queryId}' jpa.orderBy must include at least one field.`);
  }
  return Object.fromEntries(entries.map(([key, direction]) => {
    const field = key.trim();
    const normalizedDirection = direction.trim().toLowerCase();
    if (!field || !/^(asc|desc)$/.test(normalizedDirection)) {
      throw new Error(`Planner draft query '${queryId}' has an invalid jpa.orderBy binding.`);
    }
    return [field, normalizedDirection];
  }));
}

function normalizeJpaLimit(
  value: PipelineQueryDefinition["jpa"]["limit"],
  orderBy: PipelineQueryDefinition["jpa"]["orderBy"],
  queryId: string
): 1 {
  if (value !== 1) {
    throw new Error(`Planner draft query '${queryId}' jpa.limit must be 1 when present.`);
  }
  if (!orderBy || Object.keys(orderBy).length === 0) {
    throw new Error(`Planner draft query '${queryId}' jpa.limit requires jpa.orderBy.`);
  }
  return value;
}

function normalizeQuestions(questions: Question[]): Question[] {
  return questions.map((question) => ({ ...question }));
}

function normalizeContractQuestions(questions: ContractQuestion[]): ContractQuestion[] {
  return questions.map((question) => ({
    ...question,
    resolutionModes: question.resolutionModes || (question.proposedAnswer ? ["confirm", "edit", "replace"] : ["replace", "edit"])
  }));
}

function renumberFields(fields: MessageField[]): MessageField[] {
  return fields.map((field, index) => ({ ...field, number: index + 1 }));
}

function assertPlannerSemantics(
  businessSteps: BusinessStep[],
  stepContracts: StepContract[],
  pipelineSteps: PipelineStep[],
  queries: Record<string, PipelineQueryDefinition>,
  sources: Record<string, PipelineObjectSourceDefinition>,
  aspects: Record<string, AspectConfig>,
  platform: "COMPUTE" | "FUNCTION",
  inputBoundary?: PipelineInputBoundary,
  outputBoundary?: PipelineOutputBoundary,
  compositionManifest?: PipelineCompositionManifest
): void {
  const contractById = new Map(stepContracts.map((contract) => [contract.stepId, contract]));
  const pipelineById = new Map(pipelineSteps.map((step) => [step.id || stepId(step.name), step]));
  const persistenceEnabled = Boolean(aspects.persistence?.enabled);

  for (const businessStep of businessSteps) {
    const role = inferFlowRole(businessStep.flowRole, businessStep.name, businessStep.inputTypeName, businessStep.outputTypeName);
    const contract = contractById.get(businessStep.id);
    const kind = normalizeStepKind(businessStep.kind);

    if (isExplicitPersistenceStep(businessStep.name, businessStep.purpose)) {
      throw new Error(
        `Planner draft violates TPF semantics: '${businessStep.name}' materializes persistence as a business step. ` +
        "Persistence must be modeled as an aspect/plugin concern."
      );
    }

    if (role === "resume" || (role === "query" && kind !== "query")) {
      if (pipelineById.has(businessStep.id)) {
        throw new Error(
          `Planner draft violates TPF semantics: '${businessStep.name}' is a ${role} surface and must not appear in the main pipeline step sequence.`
        );
      }
      if (!contract) {
        throw new Error(`Planner draft is missing a step contract for non-forward surface '${businessStep.name}'.`);
      }
      continue;
    }

    if (!contract) {
      throw new Error(`Planner draft is missing a step contract for business step '${businessStep.name}'.`);
    }

    const pipelineStep = pipelineById.get(businessStep.id);
    if (!pipelineStep) {
      throw new Error(`Planner draft is missing a pipeline step for business step '${businessStep.name}'.`);
    }

    assertCoherentStepViews(businessStep, contract, pipelineStep);
    assertAwaitSemantics(businessStep.name, kind, businessStep, contract, pipelineStep);
    assertQuerySemantics(businessStep.name, kind, businessStep, contract, pipelineStep, queries);
    if (kind === "await" && platform === "FUNCTION") {
      throw new Error(
        `Planner draft violates TPF semantics: await step '${businessStep.name}' is not supported for FUNCTION pipelines.`
      );
    }

    if (
      persistenceEnabled &&
      (looksLikePersistedStateType(businessStep.outputTypeName) || looksLikePersistedStateType(contract.outputTypeName))
    ) {
      throw new Error(
        `Planner draft violates TPF semantics: '${businessStep.name}' emits persisted-state output '${businessStep.outputTypeName}'. ` +
        "Persistence outputs must not be modeled as explicit business-step results."
      );
    }
  }

  for (const pipelineStep of pipelineSteps) {
    const role = inferFlowRole(pipelineStep.flowRole, pipelineStep.name, pipelineStep.inputTypeName, pipelineStep.outputTypeName, pipelineStep.cardinality);
    const kind = normalizeStepKind(pipelineStep.kind);
    if (role === "resume" || (role === "query" && kind !== "query")) {
      throw new Error(
        `Planner draft violates TPF semantics: '${pipelineStep.name}' is marked as ${role} but still appears in the main pipeline step sequence.`
      );
    }
    if (isExplicitPersistenceStep(pipelineStep.name)) {
      throw new Error(
        `Planner draft violates TPF semantics: '${pipelineStep.name}' materializes persistence as a pipeline step.`
      );
    }
    if (kind === "await" && !pipelineStep.await) {
      throw new Error(`Planner draft defines await step '${pipelineStep.name}' without await configuration.`);
    }
    if (kind === "query") {
      const queryId = normalizeQueryId(pipelineStep.query);
      if (!queryId || !queries[queryId]) {
        throw new Error(`Planner draft defines query step '${pipelineStep.name}' without a matching top-level queries entry.`);
      }
    }
  }

  const forwardSteps = businessSteps.filter((step) => isForwardChainStep(step));
  for (let index = 1; index < forwardSteps.length; index += 1) {
    const previous = forwardSteps[index - 1];
    const current = forwardSteps[index];
    if (current.inputTypeName !== previous.outputTypeName) {
      throw new Error(
        `Planner draft violates TPF semantics: forward step '${current.name}' consumes '${current.inputTypeName}' but the previous forward step ` +
        `'${previous.name}' outputs '${previous.outputTypeName}'.`
      );
    }
  }

  assertBoundarySemantics(inputBoundary, outputBoundary, compositionManifest, businessSteps, sources);
}

function assertCoherentStepViews(
  businessStep: BusinessStep,
  contract: StepContract,
  pipelineStep: PipelineStep
): void {
  if (contract.stepName !== businessStep.name || pipelineStep.name !== businessStep.name) {
    throw new Error(`Planner draft defines inconsistent names for business step '${businessStep.id}'.`);
  }
  const businessKind = normalizeStepKind(businessStep.kind);
  const contractKind = normalizeStepKind(contract.kind);
  const pipelineKind = normalizeStepKind(pipelineStep.kind);
  if (businessKind !== contractKind || businessKind !== pipelineKind) {
    throw new Error(`Planner draft defines inconsistent step kinds for business step '${businessStep.name}'.`);
  }
  if (contract.inputTypeName !== businessStep.inputTypeName || pipelineStep.inputTypeName !== businessStep.inputTypeName) {
    throw new Error(`Planner draft defines inconsistent input types for business step '${businessStep.name}'.`);
  }
  if (contract.outputTypeName !== businessStep.outputTypeName || pipelineStep.outputTypeName !== businessStep.outputTypeName) {
    throw new Error(`Planner draft defines inconsistent output types for business step '${businessStep.name}'.`);
  }
  const businessRole = inferFlowRole(businessStep.flowRole, businessStep.name, businessStep.inputTypeName, businessStep.outputTypeName);
  const contractRole = inferFlowRole(contract.flowRole, contract.stepName, contract.inputTypeName, contract.outputTypeName);
  const pipelineRole = inferFlowRole(pipelineStep.flowRole, pipelineStep.name, pipelineStep.inputTypeName, pipelineStep.outputTypeName, pipelineStep.cardinality);
  if (businessRole !== contractRole || businessRole !== pipelineRole) {
    throw new Error(`Planner draft defines inconsistent flow roles for business step '${businessStep.name}'.`);
  }
  if ((businessStep.timeout || "") !== (contract.timeout || "") || (businessStep.timeout || "") !== (pipelineStep.timeout || "")) {
    throw new Error(`Planner draft defines inconsistent await timeouts for business step '${businessStep.name}'.`);
  }
  assertVirtualThreadSemantics(businessStep, contract, pipelineStep);
}

function inferFlowRole(
  explicitRole: StepFlowRole | undefined,
  stepName: string,
  inputTypeName: string,
  outputTypeName: string,
  cardinality?: PipelineStep["cardinality"]
): StepFlowRole {
  if (explicitRole) {
    return explicitRole;
  }
  if (/\bresume\b/i.test(stepName) || /\bresume\b/i.test(inputTypeName) || /\bresume\b/i.test(outputTypeName)) {
    return "resume";
  }
  if (/\bquery\b/i.test(stepName) || /\blookup\b/i.test(stepName) || /\bread\b/i.test(stepName)) {
    return "query";
  }
  if (cardinality === "EXPANSION") {
    return "expansion";
  }
  if (cardinality === "REDUCTION") {
    return "reduction";
  }
  return "forward";
}

function isExplicitPersistenceStep(stepName: string, purpose?: string): boolean {
  const persistenceVerb = /^(save|persist|store|commit)\b/i;
  return persistenceVerb.test(stepName.trim()) || Boolean(purpose && persistenceVerb.test(purpose.trim()));
}

function looksLikePersistedStateType(typeName: string): boolean {
  return /(Saved|Persisted|Stored)(State)?$/.test(typeName);
}

function normalizeStepKind(kind: StepKind | undefined): StepKind {
  return kind || "internal";
}

function normalizeQueryId(query: string | undefined): string | undefined {
  const normalized = query?.trim();
  return normalized || undefined;
}

function normalizeQueryCapture(capture: PipelineStep["capture"] | BusinessStep["capture"] | StepContract["capture"] | undefined): PipelineStep["capture"] | undefined {
  if (!capture?.keyFields?.length) {
    return undefined;
  }
  const keyFields = [...new Set(capture.keyFields.map((field) => field.trim()).filter(Boolean))];
  return keyFields.length > 0 ? { keyFields } : undefined;
}

function normalizeIdempotencyKeyFields(fields: string[] | undefined): string[] | undefined {
  if (!fields || fields.length === 0) {
    return undefined;
  }
  const normalized = fields.map((field) => field.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function assertQuerySemantics(
  stepName: string,
  kind: StepKind,
  businessStep: BusinessStep,
  contract: StepContract,
  pipelineStep: PipelineStep,
  queries: Record<string, PipelineQueryDefinition>
): void {
  const declaredQueryIds = [businessStep.query, contract.query, pipelineStep.query]
    .map(normalizeQueryId)
    .filter((value): value is string => Boolean(value));
  const queryDeclared = declaredQueryIds.length > 0
    || Boolean(businessStep.capture || contract.capture || pipelineStep.capture);

  if (kind !== "query" && queryDeclared) {
    throw new Error(`Planner draft violates TPF semantics: '${stepName}' declares query connector fields without kind 'query'.`);
  }
  if (kind !== "query") {
    return;
  }
  if (pipelineStep.cardinality !== "ONE_TO_ONE") {
    throw new Error(`Planner draft violates TPF semantics: query step '${stepName}' must use ONE_TO_ONE cardinality.`);
  }
  if (declaredQueryIds.length === 0) {
    throw new Error(`Planner draft query step '${stepName}' must declare a query id.`);
  }
  if (declaredQueryIds.length !== 3 || declaredQueryIds.some((queryId) => queryId !== declaredQueryIds[0])) {
    throw new Error(`Planner draft defines inconsistent query ids for '${stepName}'.`);
  }
  const query = queries[declaredQueryIds[0]];
  if (!query) {
    throw new Error(`Planner draft query step '${stepName}' references unknown query '${declaredQueryIds[0]}'.`);
  }
  const queryInput = query.inputType || query.input;
  const queryOutput = query.outputType || query.output;
  if (!typeNamesMatch(queryInput, businessStep.inputTypeName)) {
    throw new Error(`Planner draft query '${declaredQueryIds[0]}' input '${queryInput}' does not match step '${stepName}' input '${businessStep.inputTypeName}'.`);
  }
  if (!typeNamesMatch(queryOutput, businessStep.outputTypeName)) {
    throw new Error(`Planner draft query '${declaredQueryIds[0]}' output '${queryOutput}' does not match step '${stepName}' output '${businessStep.outputTypeName}'.`);
  }
}

function isForwardChainStep(step: BusinessStep): boolean {
  const role = inferFlowRole(step.flowRole, step.name, step.inputTypeName, step.outputTypeName);
  return role === "forward" || normalizeStepKind(step.kind) === "query";
}

function normalizeAwaitConfig(
  value: BusinessStep["await"] | StepContract["await"] | PipelineStep["await"] | undefined
): BusinessStep["await"] | undefined {
  if (!value) {
    return undefined;
  }
  return {
    ...(value.dispatch?.mode ? { dispatch: { mode: value.dispatch.mode } } : {}),
    correlation: { strategy: value.correlation.strategy },
    transport: {
      type: value.transport.type,
      ...(value.transport.config ? { config: value.transport.config } : {}),
      ...(value.transport.request ? { request: value.transport.request } : {}),
      ...(value.transport.callback ? { callback: value.transport.callback } : {}),
      ...(value.transport.response ? { response: value.transport.response } : {}),
      ...(value.transport.consumer ? { consumer: value.transport.consumer } : {}),
      ...(value.transport.headers ? { headers: value.transport.headers } : {}),
      ...(value.transport.dispatch ? { dispatch: value.transport.dispatch } : {}),
      ...(value.transport.url ? { url: value.transport.url } : {})
    }
  };
}

function assertAwaitSemantics(
  stepName: string,
  kind: StepKind,
  businessStep: BusinessStep,
  contract: StepContract,
  pipelineStep: PipelineStep
): void {
  const awaitDeclared = Boolean(businessStep.await || contract.await || pipelineStep.await);
  const timeoutDeclared = Boolean(businessStep.timeout || contract.timeout || pipelineStep.timeout);
  const idempotencyDeclared = Boolean(
    (businessStep.idempotencyKeyFields && businessStep.idempotencyKeyFields.length > 0)
      || (contract.idempotencyKeyFields && contract.idempotencyKeyFields.length > 0)
      || (pipelineStep.idempotencyKeyFields && pipelineStep.idempotencyKeyFields.length > 0)
  );
  if (kind !== "await" && (awaitDeclared || timeoutDeclared || idempotencyDeclared)) {
    throw new Error(
      `Planner draft violates TPF semantics: '${stepName}' declares await-step fields without kind 'await'.`
    );
  }
  if (kind !== "await") {
    return;
  }
  const role = inferFlowRole(businessStep.flowRole, businessStep.name, businessStep.inputTypeName, businessStep.outputTypeName);
  if (role !== "forward" && role !== "expansion" && role !== "reduction" && role !== "merge") {
    throw new Error(`Planner draft violates TPF semantics: await step '${stepName}' must remain in the main pipeline flow.`);
  }
  if (!businessStep.timeout || !contract.timeout || !pipelineStep.timeout) {
    throw new Error(`Planner draft violates TPF semantics: await step '${stepName}' must declare timeout in every step view.`);
  }
  if (!businessStep.await || !contract.await || !pipelineStep.await) {
    throw new Error(`Planner draft violates TPF semantics: await step '${stepName}' must declare await config in every step view.`);
  }
  if (!businessStep.idempotencyKeyFields?.length || !contract.idempotencyKeyFields?.length || !pipelineStep.idempotencyKeyFields?.length) {
    throw new Error(
      `Planner draft violates TPF semantics: await step '${stepName}' must declare idempotencyKeyFields in every step view.`
    );
  }
  if (businessStep.await.correlation.strategy !== contract.await.correlation.strategy
    || businessStep.await.correlation.strategy !== pipelineStep.await.correlation.strategy) {
    throw new Error(`Planner draft defines inconsistent await correlation strategy for '${stepName}'.`);
  }
  if (businessStep.await.transport.type !== contract.await.transport.type
    || businessStep.await.transport.type !== pipelineStep.await.transport.type) {
    throw new Error(`Planner draft defines inconsistent await transport type for '${stepName}'.`);
  }
}

function assertVirtualThreadSemantics(
  businessStep: BusinessStep,
  contract: StepContract,
  pipelineStep: PipelineStep
): void {
  const declarations = [
    businessStep.runOnVirtualThreads,
    contract.runOnVirtualThreads,
    pipelineStep.runOnVirtualThreads
  ];
  const declaredValues = declarations.filter((value): value is boolean => typeof value === "boolean");
  if (declaredValues.length === 0) {
    return;
  }
  if (declaredValues.some((value) => value !== declaredValues[0])) {
    throw new Error(`Planner draft defines inconsistent runOnVirtualThreads values for '${businessStep.name}'.`);
  }
  if (normalizeStepKind(businessStep.kind) !== "internal") {
    throw new Error(
      `Planner draft violates TPF semantics: '${businessStep.name}' declares runOnVirtualThreads, which is valid only for internal service steps.`
    );
  }
}

function assertBoundarySemantics(
  inputBoundary: PipelineInputBoundary | undefined,
  outputBoundary: PipelineOutputBoundary | undefined,
  compositionManifest: PipelineCompositionManifest | undefined,
  businessSteps: BusinessStep[],
  sources: Record<string, PipelineObjectSourceDefinition>
): void {
  if (compositionManifest && !inputBoundary?.subscription && !outputBoundary?.checkpoint) {
    throw new Error("Planner draft defines a compositionManifest without an input subscription or output checkpoint boundary.");
  }
  const objectInput = inputBoundary?.object;
  if (objectInput) {
    const sourceName = objectInput.source || objectInput.from;
    if (!sourceName || !sources[sourceName]) {
      throw new Error(`Planner draft input object boundary references unknown source '${sourceName || ""}'.`);
    }
    const emittedType = objectInput.emits.typeName || simpleTypeName(objectInput.emits.type);
    const firstForwardStep = businessSteps.find((step) => inferFlowRole(step.flowRole, step.name, step.inputTypeName, step.outputTypeName) === "forward");
    if (firstForwardStep && !typeNamesMatch(firstForwardStep.inputTypeName, emittedType)) {
      throw new Error(
        `Planner draft object input emits '${emittedType}' but first forward step '${firstForwardStep.name}' consumes '${firstForwardStep.inputTypeName}'.`
      );
    }
  }
  const publication = outputBoundary?.checkpoint;
  if (publication?.idempotencyKeyFields?.length) {
    const terminalForwardStep = [...businessSteps]
      .reverse()
      .find((step) => inferFlowRole(step.flowRole, step.name, step.inputTypeName, step.outputTypeName) === "forward");
    const terminalFieldNames = new Set(terminalForwardStep?.outputFields.map((field) => field.name) || []);
    for (const field of publication.idempotencyKeyFields) {
      if (!terminalFieldNames.has(field)) {
        throw new Error(
          `Planner draft output checkpoint '${publication.publication}' references unknown terminal output idempotency field '${field}'.`
        );
      }
    }
  }
}

function resolveAspects(
  inputAspects: BriefInput["aspects"],
  draftAspects?: Record<string, AspectConfig>
): Record<string, AspectConfig> | undefined {
  const aspects: Record<string, AspectConfig> = { ...(draftAspects || {}) };
  if (!inputAspects) {
    return Object.keys(aspects).length > 0 ? aspects : undefined;
  }
  if (Array.isArray(inputAspects)) {
    for (const aspectName of inputAspects) {
      aspects[aspectName] = { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" };
    }
    return aspects;
  }
  for (const [name, value] of Object.entries(inputAspects)) {
    if (typeof value === "boolean") {
      if (value) {
        aspects[name] = { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" };
      }
      continue;
    }
    aspects[name] = value;
  }
  return Object.keys(aspects).length > 0 ? aspects : undefined;
}

function deriveCouplingFindings(steps: BusinessStep[]): CouplingFinding[] {
  const producedByField = new Map<string, number>();
  const findings: CouplingFinding[] = [];

  steps.forEach((step, index) => {
    for (const field of step.outputFields) {
      if (!producedByField.has(field.name)) {
        producedByField.set(field.name, index);
      }
    }
  });

  steps.forEach((step, index) => {
    if (index < 2) {
      return;
    }
    const coupledFields = step.inputFields
      .map((field) => field.name)
      .filter((fieldName) => {
        const sourceIndex = producedByField.get(fieldName);
        return sourceIndex !== undefined && sourceIndex < index - 1;
      });
    if (coupledFields.length === 0) {
      return;
    }
    const sourceIndex = producedByField.get(coupledFields[0]);
    if (sourceIndex === undefined) {
      return;
    }
    findings.push({
      id: `coupling.${steps[sourceIndex].id}.${step.id}`,
      sourceStep: steps[sourceIndex].id,
      targetStep: step.id,
      fields: coupledFields,
      severity: coupledFields.length > 2 ? "warning" : "info",
      rationale: "These fields originate earlier in the flow than the immediately preceding step, so the contract carries non-local coupling."
    });
  });

  return findings;
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

function defaultAppName(title: string): string {
  const tokens = namingTokens(title, 6);
  if (tokens.length === 0) {
    return "PipelineApplication";
  }
  return toPascalCase(tokens.join(" "));
}

function defaultBasePackage(title: string): string {
  const tokens = namingTokens(title, 5).map((token) => token.slice(0, 20));
  if (tokens.length === 0) {
    return "";
  }
  return `com.example.${tokens.join(".")}`.slice(0, 80).replace(/\.+$/g, "");
}

function namingTokens(title: string, limit: number): string[] {
  const stopWords = new Set(["a", "an", "and", "as", "backend", "brief", "by", "core", "for", "in", "incremental", "mvp", "new", "of", "on", "profile", "secure", "story", "system", "the", "to", "user", "with"]);
  const rawTokens = title.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens.filter((token) => !stopWords.has(token));
  return (tokens.length > 0 ? tokens : rawTokens)
    .filter((token) => /^[a-z0-9]+$/.test(token))
    .slice(0, limit);
}

function toPascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function stepId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

function isLikelyJavaPackage(value: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(value);
}
