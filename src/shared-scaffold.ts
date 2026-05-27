import YAML from "js-yaml";
import JSZip from "jszip";
import { assertDerivedConfigInvariants } from "./derived-config-validation.js";
import type { DerivedConfig, MessageDefinition, MessageField } from "./types.js";

type BrowserTemplateEngineCtor = new (templates?: Record<string, string>) => {
  generateApplication(options: {
    appName: string;
    basePackage: string;
    steps: Array<Record<string, unknown>>;
    aspects?: Record<string, unknown>;
    transport?: string;
    platform?: string;
    runtimeLayout?: string;
    fileCallback: (filePath: string, content: string) => Promise<void> | void;
  }): Promise<void>;
};

const browserTemplateEnginePromise = initializeBrowserTemplateEngine();

export async function generateScaffoldZip(config: DerivedConfig): Promise<Uint8Array> {
  assertDerivedConfigInvariants(config);
  const zip = new JSZip();
  const engine = await browserTemplateEnginePromise;
  const scaffoldConfig = toWorkerScaffoldConfig(config);
  await engine.generateApplication({
    ...scaffoldConfig,
    fileCallback: async (filePath, content) => {
      zip.file(filePath, content);
    }
  });
  zip.file("config/pipeline.yaml", YAML.dump(config, { lineWidth: -1 }));
  return zip.generateAsync({ type: "uint8array" });
}

async function initializeBrowserTemplateEngine(): Promise<InstanceType<BrowserTemplateEngineCtor>> {
  const { BrowserTemplateEngine, templates } = await loadBrowserGenerator();
  return new BrowserTemplateEngine(templates);
}

async function loadBrowserGenerator(): Promise<{ BrowserTemplateEngine: BrowserTemplateEngineCtor; templates: Record<string, string> }> {
  const [engineModule, templatesModule] = isWorkerRuntime()
    ? await Promise.all([
        // @ts-ignore Plain JS module imported from the vendored generator snapshot for Worker bundling.
        import("../template-generator-node/src/browser-template-engine.js"),
        // @ts-ignore Plain JS module imported from the vendored generator snapshot for Worker bundling.
        import("../template-generator-node/src/template-bundle-precompiled.js")
      ])
    : await Promise.all([
        import(new URL("../../template-generator-node/src/browser-template-engine.js", import.meta.url).href),
        import(new URL("../../template-generator-node/src/template-bundle-precompiled.js", import.meta.url).href)
      ]);
  return {
    BrowserTemplateEngine: (engineModule.default || engineModule) as BrowserTemplateEngineCtor,
    templates: (templatesModule.default || templatesModule) as Record<string, string>
  };
}

function isWorkerRuntime(): boolean {
  return typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== "undefined";
}

function toWorkerScaffoldConfig(config: DerivedConfig): {
  appName: string;
  basePackage: string;
  steps: Array<Record<string, unknown>>;
  aspects?: Record<string, unknown>;
  transport?: string;
  platform?: string;
  runtimeLayout?: string;
} {
  const materializedSteps = config.steps.map((step) => ({
    ...step,
    inputFields: materializeStepFields(step.inputTypeName, undefined, config.messages),
    outputFields: materializeStepFields(step.outputTypeName, undefined, config.messages)
  }));

  return {
    appName: config.appName,
    basePackage: config.basePackage,
    steps: processSteps(materializedSteps),
    aspects: config.aspects,
    transport: normalizeTransport(config.transport, normalizeRuntimeLayout(config.runtimeLayout)),
    platform: normalizePlatform(config.platform),
    runtimeLayout: normalizeRuntimeLayout(config.runtimeLayout)
  };
}

function materializeStepFields(
  typeName: string,
  inlineFields: MessageField[] | undefined,
  messages: Record<string, MessageDefinition>
): Array<Record<string, unknown>> {
  const messageDefinition = typeName ? messages[typeName] : undefined;
  const topLevel = messageDefinition?.fields;
  if (typeName && !topLevel && !inlineFields) {
    throw new Error(`Missing message definition for '${typeName}'`);
  }
  const sourceFields = topLevel || inlineFields || [];
  return sourceFields.map((field) => toScaffoldField(field));
}

function toScaffoldField(field: MessageField & { keyType?: string; valueType?: string }): Record<string, unknown> {
  const authoredType = field.type;
  if (authoredType === "map") {
    const keyJava = isMessageReferenceType(field.keyType) ? field.keyType : semanticTypeToJavaType(field.keyType);
    const valueJava = isMessageReferenceType(field.valueType) ? field.valueType : semanticTypeToJavaType(field.valueType);
    const keyProto = isMessageReferenceType(field.keyType) ? field.keyType : semanticTypeToProtoType(field.keyType);
    const valueProto = isMessageReferenceType(field.valueType) ? field.valueType : semanticTypeToProtoType(field.valueType);
    return {
      ...field,
      type: `Map<${keyJava}, ${valueJava}>`,
      protoType: `map<${keyProto}, ${valueProto}>`
    };
  }
  if (isMessageReferenceType(authoredType)) {
    if (field.repeated) {
      return {
        ...field,
        type: `List<${authoredType}>`,
        protoType: authoredType
      };
    }
    return {
      ...field,
      type: authoredType,
      protoType: authoredType
    };
  }
  const javaType = semanticTypeToJavaType(authoredType);
  const protoType = semanticTypeToProtoType(authoredType);
  if (field.repeated) {
    return {
      ...field,
      type: `List<${javaType}>`,
      protoType
    };
  }
  return {
    ...field,
    type: javaType,
    protoType
  };
}

function processSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return steps.map((step, index) => {
    const processedStep = { ...step } as Record<string, unknown>;
    const name = String(step.name || "");

    if (!processedStep.serviceName) {
      processedStep.serviceName = `${name.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}-svc`;
    }
    if (!processedStep.serviceNameCamel) {
      let entityName = name
        .replace("Process ", "")
        .replace("Validate ", "")
        .replace("Enrich ", "")
        .trim();
      entityName = entityName.replace(/[^a-zA-Z0-9]/g, " ").trim();
      const camelCaseName = toCamelCase(entityName);
      processedStep.serviceNameCamel = camelCaseName.charAt(0).toUpperCase() + camelCaseName.slice(1);
    }
    if (!processedStep.serviceNameTitleCase) {
      processedStep.serviceNameTitleCase = `${toTitleCase(String(processedStep.serviceName).replace(/-svc$/, ""))}Svc`;
    }
    if (!processedStep.inputTypeSimpleName) {
      processedStep.inputTypeSimpleName = String(step.inputTypeName || "").replace(/.*\./, "");
    }
    if (!processedStep.outputTypeSimpleName) {
      processedStep.outputTypeSimpleName = String(step.outputTypeName || "").replace(/.*\./, "");
    }
    processedStep.portOffset = index + 1;
    if (!processedStep.stepType) {
      processedStep.stepType = getStepTypeForCardinality(String(step.cardinality || "ONE_TO_ONE"));
    }
    if (processedStep.batchSize === undefined) {
      processedStep.batchSize = 10;
    }
    if (processedStep.batchTimeoutMs === undefined) {
      processedStep.batchTimeoutMs = 1000;
    }
    return processedStep;
  });
}

function isMessageReferenceType(type: unknown): type is string {
  return typeof type === "string" && /^[A-Z][A-Za-z0-9_]*$/.test(type);
}

function semanticTypeToJavaType(type: unknown): string {
  switch (type) {
    case "string": return "String";
    case "bool": return "Boolean";
    case "int32": return "Integer";
    case "int64": return "Long";
    case "float32": return "Float";
    case "float64": return "Double";
    case "decimal": return "BigDecimal";
    case "uuid": return "UUID";
    case "timestamp": return "Instant";
    case "datetime": return "LocalDateTime";
    case "date": return "LocalDate";
    case "duration": return "Duration";
    case "bytes": return "byte[]";
    case "currency": return "Currency";
    case "uri": return "URI";
    case "path": return "Path";
    default: return String(type);
  }
}

function semanticTypeToProtoType(type: unknown): string {
  switch (type) {
    case "bool": return "bool";
    case "int32": return "int32";
    case "int64": return "int64";
    case "float32": return "float";
    case "float64": return "double";
    case "bytes": return "bytes";
    default: return "string";
  }
}

function normalizeRuntimeLayout(runtimeLayout: DerivedConfig["runtimeLayout"]): string {
  if (runtimeLayout == null) {
    return "modular";
  }
  if (typeof runtimeLayout !== "string") {
    return "modular";
  }
  const normalized = runtimeLayout.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "modular" || normalized === "pipeline-runtime" || normalized === "monolith") {
    return normalized;
  }
  return "modular";
}

function normalizeTransport(transport: DerivedConfig["transport"], runtimeLayout: string): string {
  const fallback = runtimeLayout === "monolith" ? "LOCAL" : "GRPC";
  if (transport == null) {
    return fallback;
  }
  const normalized = String(transport).trim().toUpperCase();
  if (normalized === "GRPC" || normalized === "REST" || normalized === "LOCAL") {
    return normalized;
  }
  return fallback;
}

function normalizePlatform(platform: DerivedConfig["platform"]): string {
  if (platform == null) {
    return "COMPUTE";
  }
  const normalized = String(platform).trim().toUpperCase();
  if (normalized === "FUNCTION" || normalized === "LAMBDA") {
    return "FUNCTION";
  }
  return "COMPUTE";
}

function getStepTypeForCardinality(cardinality: string): string {
  switch (cardinality) {
    case "EXPANSION":
      return "StepOneToMany";
    case "REDUCTION":
      return "StepManyToOne";
    case "SIDE_EFFECT":
      return "StepSideEffect";
    default:
      return "StepOneToOne";
  }
}

function toCamelCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part, index) => index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toTitleCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}
