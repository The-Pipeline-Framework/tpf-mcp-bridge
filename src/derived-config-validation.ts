import type { DerivedConfig } from "./types.js";

const MAX_BASE_PACKAGE_LENGTH = 80;
const MAX_PACKAGE_SEGMENTS = 8;
const MAX_PACKAGE_SEGMENT_LENGTH = 24;
const MAX_APP_NAME_LENGTH = 80;

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
  for (const step of config.steps || []) {
    if (!knownMessages.has(step.inputTypeName)) {
      throw new DerivedConfigValidationError(`Step '${step.name}' references unknown input type '${step.inputTypeName}'.`);
    }
    if (!knownMessages.has(step.outputTypeName)) {
      throw new DerivedConfigValidationError(`Step '${step.name}' references unknown output type '${step.outputTypeName}'.`);
    }
    validateAwaitStep(config, step);
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
