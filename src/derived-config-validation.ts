import type { DerivedConfig, PipelineCompositionManifest } from "./types.js";

const MAX_BASE_PACKAGE_LENGTH = 80;
const MAX_PACKAGE_SEGMENTS = 8;
const MAX_PACKAGE_SEGMENT_LENGTH = 24;
const MAX_APP_NAME_LENGTH = 80;
const MAX_COMPOSITION_PIPELINE_ID_LENGTH = 80;
const MAX_COMPOSITION_PIPELINE_PATH_LENGTH = 240;

export class DerivedConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedConfigValidationError";
  }
}

export function assertDerivedConfigInvariants(config: DerivedConfig): void {
  validateAppName(config.appName);
  validateBasePackage(config.basePackage);

  const messageEntries = Object.entries(config.messages || {});
  if (messageEntries.length === 0) {
    throw new DerivedConfigValidationError("Derived config must include at least one top-level message.");
  }

  for (const [messageName, definition] of messageEntries) {
    if (!definition || !Array.isArray(definition.fields)) {
      throw new DerivedConfigValidationError(`Message '${messageName}' is missing its field catalog.`);
    }
    const seenNames = new Set<string>();
    definition.fields.forEach((field, index) => {
      if (seenNames.has(field.name)) {
        throw new DerivedConfigValidationError(`Message '${messageName}' defines duplicate field '${field.name}'.`);
      }
      seenNames.add(field.name);
      if (field.number !== index + 1) {
        throw new DerivedConfigValidationError(`Message '${messageName}' has non-sequential field numbering.`);
      }
    });
  }

  const knownMessages = new Set(messageEntries.map(([name]) => name));
  const unionEntries = Object.entries(config.unions || {});
  const knownUnions = new Set(unionEntries.map(([name]) => name));
  for (const [unionName, definition] of unionEntries) {
    const variants = Object.entries(definition?.variants || {});
    if (variants.length === 0) {
      throw new DerivedConfigValidationError(`Union '${unionName}' must define at least one variant.`);
    }
    for (const [variantName, variant] of variants) {
      if (!knownMessages.has(variant.type)) {
        throw new DerivedConfigValidationError(
          `Union '${unionName}' variant '${variantName}' references unknown message type '${variant.type}'.`
        );
      }
    }
  }
  const knownBoundaryTypes = new Set([...knownMessages, ...knownUnions]);
  validateObjectSources(config);
  validateBoundaries(config, knownBoundaryTypes);
  validateQueryDefinitions(config, knownMessages);
  for (const step of config.steps || []) {
    if (!knownBoundaryTypes.has(step.inputTypeName)) {
      throw new DerivedConfigValidationError(`Step '${step.name}' references unknown input type '${step.inputTypeName}'.`);
    }
    if (!knownBoundaryTypes.has(step.outputTypeName)) {
      throw new DerivedConfigValidationError(`Step '${step.name}' references unknown output type '${step.outputTypeName}'.`);
    }
    validateVirtualThreadStep(step);
    validateAwaitStep(config, step);
    validateQueryStep(config, step, knownMessages);
  }
}

export function assertCompositionManifestInvariants(manifest: PipelineCompositionManifest | undefined): void {
  if (!manifest) {
    return;
  }
  if (manifest.version !== 1) {
    throw new DerivedConfigValidationError("Pipeline composition manifest version must be 1.");
  }
  if (!manifest.name?.trim()) {
    throw new DerivedConfigValidationError("Pipeline composition manifest must include a non-empty name.");
  }
  if (!manifest.pipelines?.length) {
    throw new DerivedConfigValidationError("Pipeline composition manifest must include at least one pipeline.");
  }
  for (const pipeline of manifest.pipelines) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(pipeline.id)) {
      throw new DerivedConfigValidationError(`Pipeline composition id '${pipeline.id}' is invalid.`);
    }
    if (pipeline.id.length > MAX_COMPOSITION_PIPELINE_ID_LENGTH) {
      throw new DerivedConfigValidationError(`Pipeline composition id '${pipeline.id}' exceeds the supported length budget.`);
    }
    if (!pipeline.path?.trim()) {
      throw new DerivedConfigValidationError(`Pipeline composition entry '${pipeline.id}' must include a path.`);
    }
    if (pipeline.path.length > MAX_COMPOSITION_PIPELINE_PATH_LENGTH) {
      throw new DerivedConfigValidationError(`Pipeline composition path for '${pipeline.id}' exceeds the supported length budget.`);
    }
  }
}

function validateAppName(appName: string): void {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(appName)) {
    throw new DerivedConfigValidationError(`Derived config appName '${appName}' is not a safe Java/Maven identifier.`);
  }
  if (appName.length > MAX_APP_NAME_LENGTH) {
    throw new DerivedConfigValidationError(`Derived config appName '${appName}' exceeds the supported length budget.`);
  }
}

function validateBasePackage(basePackage: string): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(basePackage)) {
    throw new DerivedConfigValidationError(`Derived config basePackage '${basePackage}' is not a valid Java package.`);
  }
  if (basePackage.length > MAX_BASE_PACKAGE_LENGTH) {
    throw new DerivedConfigValidationError(`Derived config basePackage '${basePackage}' exceeds the supported length budget.`);
  }
  const segments = basePackage.split(".");
  if (segments.length > MAX_PACKAGE_SEGMENTS) {
    throw new DerivedConfigValidationError(`Derived config basePackage '${basePackage}' uses too many package segments.`);
  }
  if (segments.some((segment) => segment.length > MAX_PACKAGE_SEGMENT_LENGTH)) {
    throw new DerivedConfigValidationError(`Derived config basePackage '${basePackage}' contains an overlong package segment.`);
  }
}

function validateAwaitStep(config: DerivedConfig, step: DerivedConfig["steps"][number]): void {
  if (step.kind !== "await") {
    if (step.await || step.timeout || (step.idempotencyKeyFields && step.idempotencyKeyFields.length > 0)) {
      throw new DerivedConfigValidationError(
        `Step '${step.name}' declares await-step fields but is not marked as kind 'await'.`
      );
    }
    return;
  }

  if (String(config.platform || "").toUpperCase() === "FUNCTION") {
    throw new DerivedConfigValidationError(`Await step '${step.name}' is not supported for FUNCTION pipelines.`);
  }
  if (!step.timeout?.trim()) {
    throw new DerivedConfigValidationError(`Await step '${step.name}' must declare timeout.`);
  }
  if (!step.await) {
    throw new DerivedConfigValidationError(`Await step '${step.name}' must declare await config.`);
  }
  if (!step.idempotencyKeyFields?.length) {
    throw new DerivedConfigValidationError(`Await step '${step.name}' must declare idempotencyKeyFields.`);
  }
  if (!step.await.correlation?.strategy) {
    throw new DerivedConfigValidationError(`Await step '${step.name}' must declare await.correlation.strategy.`);
  }
  if (!step.await.transport?.type) {
    throw new DerivedConfigValidationError(`Await step '${step.name}' must declare await.transport.type.`);
  }
  if (step.await.transport.type === "webhook") {
    const request = step.await.transport.request;
    const callback = step.await.transport.callback;
    const rawTransport = step.await.transport as unknown as Record<string, unknown>;
    const requestUrl = typeof request?.url === "string"
      ? request.url
      : typeof rawTransport.url === "string"
        ? rawTransport.url
        : undefined;
    if (!requestUrl?.trim()) {
      throw new DerivedConfigValidationError(`Await step '${step.name}' with webhook transport must declare request.url.`);
    }
    if (callback && typeof callback !== "object") {
      throw new DerivedConfigValidationError(`Await step '${step.name}' has invalid webhook callback config.`);
    }
  }
  if (step.await.transport.type === "kafka") {
    const request = step.await.transport.request;
    const response = step.await.transport.response;
    const requestTopic = typeof request?.topic === "string" ? request.topic : undefined;
    const responseTopic = typeof response?.topic === "string" ? response.topic : undefined;
    if (!requestTopic?.trim()) {
      throw new DerivedConfigValidationError(`Await step '${step.name}' with kafka transport must declare request.topic.`);
    }
    if (!responseTopic?.trim()) {
      throw new DerivedConfigValidationError(`Await step '${step.name}' with kafka transport must declare response.topic.`);
    }
    const key = typeof request?.key === "string" ? request.key : undefined;
    if (key && key !== "interactionId" && key !== "correlationId") {
      throw new DerivedConfigValidationError(
        `Await step '${step.name}' with kafka transport must use request.key interactionId or correlationId.`
      );
    }
  }
  if (step.await.transport.type === "sqs") {
    const request = step.await.transport.request;
    const response = step.await.transport.response;
    const requestQueueUrl = typeof request?.queueUrl === "string" ? request.queueUrl : undefined;
    const responseQueueUrl = typeof response?.queueUrl === "string" ? response.queueUrl : undefined;
    if (!requestQueueUrl?.trim()) {
      throw new DerivedConfigValidationError(`Await step '${step.name}' with sqs transport must declare request.queueUrl.`);
    }
    if (!responseQueueUrl?.trim()) {
      throw new DerivedConfigValidationError(`Await step '${step.name}' with sqs transport must declare response.queueUrl.`);
    }
  }
  const dispatchMode = step.await.dispatch?.mode;
  if (dispatchMode && dispatchMode !== "single" && dispatchMode !== "per-item") {
    throw new DerivedConfigValidationError(
      `Await step '${step.name}' uses unsupported await.dispatch.mode '${dispatchMode}'.`
    );
  }
  if (step.cardinality === "MANY_TO_MANY" && dispatchMode && dispatchMode !== "per-item") {
    throw new DerivedConfigValidationError(
      `Await step '${step.name}' with MANY_TO_MANY cardinality requires await.dispatch.mode=per-item.`
    );
  }
  if (step.cardinality !== "MANY_TO_MANY" && dispatchMode === "per-item") {
    throw new DerivedConfigValidationError(
      `Await step '${step.name}' uses await.dispatch.mode=per-item, which is only supported for MANY_TO_MANY cardinality.`
    );
  }
}

function validateQueryDefinitions(config: DerivedConfig, knownMessages: Set<string>): void {
  const queryEntries = Object.entries(config.queries || {});
  for (const [queryId, query] of queryEntries) {
    if (!queryId.trim()) {
      throw new DerivedConfigValidationError("Query definition id must not be empty.");
    }
    if (query.connector !== "jpa") {
      throw new DerivedConfigValidationError(`Query '${queryId}' uses unsupported connector '${String(query.connector)}'.`);
    }
    const inputType = query.inputType || query.input;
    const outputType = query.outputType || query.output;
    if (!inputType?.trim()) {
      throw new DerivedConfigValidationError(`Query '${queryId}' must declare input or inputType.`);
    }
    if (!outputType?.trim()) {
      throw new DerivedConfigValidationError(`Query '${queryId}' must declare output or outputType.`);
    }
    if (!hasKnownType(knownMessages, inputType)) {
      throw new DerivedConfigValidationError(`Query '${queryId}' references unknown input type '${inputType}'.`);
    }
    if (!hasKnownType(knownMessages, outputType)) {
      throw new DerivedConfigValidationError(`Query '${queryId}' references unknown output type '${outputType}'.`);
    }
    if (!query.jpa?.entity?.trim()) {
      throw new DerivedConfigValidationError(`Query '${queryId}' must declare jpa.entity.`);
    }
    if (!query.jpa.where || Object.keys(query.jpa.where).length === 0) {
      throw new DerivedConfigValidationError(`Query '${queryId}' must declare at least one jpa.where binding.`);
    }
    for (const [field, expression] of Object.entries(query.jpa.where)) {
      if (!field.trim() || !expression.trim()) {
        throw new DerivedConfigValidationError(`Query '${queryId}' has an invalid jpa.where binding.`);
      }
    }
    if (query.jpa.result && query.jpa.result !== "single") {
      throw new DerivedConfigValidationError(`Query '${queryId}' uses unsupported jpa.result '${query.jpa.result}'.`);
    }
  }
}

function validateQueryStep(
  config: DerivedConfig,
  step: DerivedConfig["steps"][number],
  knownMessages: Set<string>
): void {
  if (step.kind !== "query") {
    if (step.query || step.capture) {
      throw new DerivedConfigValidationError(
        `Step '${step.name}' declares query connector fields but is not marked as kind 'query'.`
      );
    }
    return;
  }

  if (step.await || step.timeout || step.idempotencyKeyFields?.length) {
    throw new DerivedConfigValidationError(`Query step '${step.name}' must not declare await-step fields.`);
  }
  if (step.cardinality !== "ONE_TO_ONE") {
    throw new DerivedConfigValidationError(`Query step '${step.name}' must use ONE_TO_ONE cardinality.`);
  }
  if (step.runOnVirtualThreads) {
    throw new DerivedConfigValidationError(`Query step '${step.name}' must not declare runOnVirtualThreads.`);
  }
  const queryId = step.query?.trim();
  if (!queryId) {
    throw new DerivedConfigValidationError(`Query step '${step.name}' must reference a query id.`);
  }
  const query = config.queries?.[queryId];
  if (!query) {
    throw new DerivedConfigValidationError(`Query step '${step.name}' references unknown query '${queryId}'.`);
  }
  const queryInput = query.inputType || query.input;
  const queryOutput = query.outputType || query.output;
  if (!typeNamesMatch(queryInput, step.inputTypeName)) {
    throw new DerivedConfigValidationError(
      `Query step '${step.name}' input '${step.inputTypeName}' does not match query '${queryId}' input '${queryInput}'.`
    );
  }
  if (!typeNamesMatch(queryOutput, step.outputTypeName)) {
    throw new DerivedConfigValidationError(
      `Query step '${step.name}' output '${step.outputTypeName}' does not match query '${queryId}' output '${queryOutput}'.`
    );
  }
  const inputMessageName = simpleTypeName(step.inputTypeName);
  const inputFields = knownMessages.has(inputMessageName) ? config.messages[inputMessageName]?.fields || [] : [];
  const inputFieldNames = new Set(inputFields.map((field) => field.name));
  for (const keyField of step.capture?.keyFields || []) {
    if (!inputFieldNames.has(keyField)) {
      throw new DerivedConfigValidationError(
        `Query step '${step.name}' capture key field '${keyField}' is not present on input type '${step.inputTypeName}'.`
      );
    }
  }
}

function validateVirtualThreadStep(step: DerivedConfig["steps"][number]): void {
  if (!step.runOnVirtualThreads) {
    return;
  }
  if (step.kind && step.kind !== "internal") {
    throw new DerivedConfigValidationError(
      `Step '${step.name}' declares runOnVirtualThreads, which is valid only for internal service steps.`
    );
  }
}

// TPF scaffold messages are keyed by unique simple names today. If fully-qualified
// message keys are introduced, update these helpers to detect simple-name collisions.
function hasKnownType(knownMessages: Set<string>, value: string): boolean {
  return knownMessages.has(value) || knownMessages.has(simpleTypeName(value));
}

function typeNamesMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return left === right || simpleTypeName(left) === simpleTypeName(right);
}

function simpleTypeName(value: string): string {
  return value.replace(/.*\./, "");
}

function validateObjectSources(config: DerivedConfig): void {
  for (const [sourceName, source] of Object.entries(config.sources || {})) {
    validateBoundaryName(sourceName, "sources entry");
    if (source.kind !== "object") {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' must declare kind 'object'.`);
    }
    if (source.provider !== "filesystem" && source.provider !== "s3") {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' uses unsupported provider '${source.provider}'.`);
    }
    const location = source.location || {};
    if (source.provider === "filesystem" && typeof location.root !== "string") {
      throw new DerivedConfigValidationError(`Filesystem object source '${sourceName}' must declare location.root.`);
    }
    if (source.provider === "s3" && typeof location.bucket !== "string") {
      throw new DerivedConfigValidationError(`S3 object source '${sourceName}' must declare location.bucket.`);
    }
    if (source.poll?.batchSize !== undefined && source.poll.batchSize <= 0) {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' poll.batchSize must be positive.`);
    }
    if (source.poll?.interval !== undefined && !source.poll.interval.trim()) {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' poll.interval must not be empty.`);
    }
    if (source.payload?.mode && !["metadata", "reference", "text"].includes(source.payload.mode)) {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' payload.mode '${source.payload.mode}' is unsupported.`);
    }
    if (source.payload?.maxBytes !== undefined && source.payload.maxBytes < 0) {
      throw new DerivedConfigValidationError(`Object source '${sourceName}' payload.maxBytes must not be negative.`);
    }
  }
}

function validateBoundaries(config: DerivedConfig, knownBoundaryTypes: Set<string>): void {
  const subscription = config.input?.subscription;
  const objectInput = config.input?.object || legacyObjectInputBoundary(config.input);
  const checkpoint = config.output?.checkpoint;
  if (subscription && objectInput) {
    throw new DerivedConfigValidationError("Derived config input must not declare both subscription and object boundaries.");
  }
  if (subscription) {
    validateBoundaryName(subscription.publication, "input.subscription.publication");
    if (subscription.mapper && !/^[a-zA-Z_$][a-zA-Z\d_$]*(\.[a-zA-Z_$][a-zA-Z\d_$]*)*\.[A-Z][a-zA-Z\d_$]*$/.test(subscription.mapper)) {
      throw new DerivedConfigValidationError(`Input subscription mapper '${subscription.mapper}' is not a valid Java type name.`);
    }
  }
  if (objectInput) {
    const sourceName = objectInput.source || objectInput.from;
    if (!sourceName?.trim()) {
      throw new DerivedConfigValidationError("Input object boundary must declare source.");
    }
    if (!config.sources?.[sourceName]) {
      throw new DerivedConfigValidationError(`Input object boundary references unknown source '${sourceName}'.`);
    }
    const emittedType = objectInput.emits?.typeName || simpleTypeName(objectInput.emits?.type || "");
    if (!emittedType || !hasKnownType(knownBoundaryTypes, emittedType)) {
      throw new DerivedConfigValidationError(`Input object boundary emits unknown type '${emittedType}'.`);
    }
    if (!objectInput.emits?.mapper || !/^[a-zA-Z_$][a-zA-Z\d_$]*(\.[a-zA-Z_$][a-zA-Z\d_$]*)*\.[A-Z][a-zA-Z\d_$]*$/.test(objectInput.emits.mapper)) {
      throw new DerivedConfigValidationError(`Input object boundary mapper '${objectInput.emits?.mapper || ""}' is not a valid Java type name.`);
    }
    const firstForwardStep = config.steps?.find((step) => step.kind !== "query");
    if (firstForwardStep && !typeNamesMatch(firstForwardStep.inputTypeName, emittedType)) {
      throw new DerivedConfigValidationError(
        `Input object boundary emits '${emittedType}' but first pipeline step '${firstForwardStep.name}' consumes '${firstForwardStep.inputTypeName}'.`
      );
    }
  }
  if (checkpoint) {
    validateBoundaryName(checkpoint.publication, "output.checkpoint.publication");
    if (checkpoint.idempotencyKeyFields?.length) {
      // Checkpoint idempotency is keyed against the terminal forward output, including await outputs.
      const lastStep = [...(config.steps || [])].reverse().find((step) => step.kind !== "await" || step.outputTypeName);
      const outputFields = lastStep ? config.messages[lastStep.outputTypeName]?.fields || [] : [];
      const fieldNames = new Set(outputFields.map((field) => field.name));
      for (const field of checkpoint.idempotencyKeyFields) {
        if (!fieldNames.has(field)) {
          throw new DerivedConfigValidationError(
            `Output checkpoint '${checkpoint.publication}' references unknown terminal output idempotency field '${field}'.`
          );
        }
      }
    }
  }
}

function legacyObjectInputBoundary(input: DerivedConfig["input"]): NonNullable<DerivedConfig["input"]>["object"] | undefined {
  const legacy = input as unknown as { from?: string; emits?: NonNullable<NonNullable<DerivedConfig["input"]>["object"]>["emits"] } | undefined;
  return legacy?.from && legacy.emits ? { source: legacy.from, emits: legacy.emits } : undefined;
}

function validateBoundaryName(value: string, label: string): void {
  if (!value?.trim()) {
    throw new DerivedConfigValidationError(`Derived config ${label} must not be empty.`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(value)) {
    throw new DerivedConfigValidationError(`Derived config ${label} '${value}' is not a valid checkpoint publication name.`);
  }
}
