import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "js-yaml";
import { generateScaffold } from "../dist/src/template-bridge.js";

const require = createRequire(import.meta.url);
const pipelineSchema = require("../template-generator-node/src/pipeline-template-schema.json");
const compositionSchema = require("../template-generator-node/src/pipeline-composition-schema.json");
const DEFAULT_SMOKE_NAME = "checkpoint-composition-smoke";

const args = parseArgs(process.argv.slice(2));
const frameworkDirArg = args.frameworkDir || process.env.TPF_FRAMEWORK_DIR;
const smokeName = args.smokeName || process.env.TPF_SMOKE_NAME || DEFAULT_SMOKE_NAME;
validateSmokeName(smokeName);

if (!frameworkDirArg) {
  usage("Missing --framework-dir or TPF_FRAMEWORK_DIR.");
}

const frameworkDir = path.resolve(frameworkDirArg);

if (!existsSync(path.join(frameworkDir, "pom.xml"))) {
  usage(`Framework directory does not contain a root pom.xml: ${frameworkDir}`);
}

const outputDir = path.join(frameworkDir, "examples", smokeName);
await rm(outputDir, { recursive: true, force: true });
await generateScaffold(buildCheckpointConfig(), outputDir, buildCompositionManifest(smokeName));

const pipelinePath = path.join(outputDir, "config", "pipeline.yaml");
const compositionPath = path.join(outputDir, "config", "pipeline-composition.yaml");
const monolithPropertiesPath = path.join(outputDir, "monolith-svc", "src", "main", "resources", "application.properties");
if (!existsSync(pipelinePath)) {
  throw new Error(`Generated scaffold is missing config/pipeline.yaml: ${pipelinePath}`);
}
if (!existsSync(compositionPath)) {
  throw new Error(`Generated scaffold is missing config/pipeline-composition.yaml: ${compositionPath}`);
}
if (!existsSync(monolithPropertiesPath)) {
  throw new Error(`Generated scaffold is missing monolith application.properties: ${monolithPropertiesPath}`);
}

const pipelineConfig = YAML.load(readFileSync(pipelinePath, "utf8"));
const composition = YAML.load(readFileSync(compositionPath, "utf8"));
validateSchema("pipeline.yaml", pipelineSchema, pipelineConfig);
validateSchema("pipeline-composition.yaml", compositionSchema, composition);

if (pipelineConfig.input?.subscription?.publication !== "payments.validated") {
  throw new Error("Generated pipeline.yaml is missing the input checkpoint subscription.");
}
if (pipelineConfig.output?.checkpoint?.publication !== "settlements.ready") {
  throw new Error("Generated pipeline.yaml is missing the output checkpoint publication.");
}
if (!Array.isArray(composition.pipelines) || composition.pipelines.length !== 3) {
  throw new Error("Generated composition manifest must include upstream, current, and downstream pipeline entries.");
}
const monolithProperties = readFileSync(monolithPropertiesPath, "utf8");
if (!monolithProperties.includes("pipeline.orchestrator.mode=QUEUE_ASYNC")) {
  throw new Error("Generated monolith application.properties must enable QUEUE_ASYNC for checkpoint handoff.");
}
if (!monolithProperties.includes("pipeline.orchestrator.resume-token-secret=${TPF_RESUME_TOKEN_SECRET}")) {
  throw new Error("Generated monolith application.properties must require TPF_RESUME_TOKEN_SECRET for checkpoint handoff.");
}

const currentPipeline = composition.pipelines.find((pipeline) => pipeline.id === "settlement-preparation");
if (!currentPipeline) {
  throw new Error("Generated composition manifest is missing the current pipeline entry.");
}
const resolvedCurrentPath = path.resolve(outputDir, currentPipeline.path);
if (resolvedCurrentPath !== pipelinePath) {
  throw new Error(
    `Generated composition path for settlement-preparation points to ${resolvedCurrentPath}, expected ${pipelinePath}.`
  );
}

await run(
  path.join(frameworkDir, "mvnw"),
  ["-f", `examples/${smokeName}/pom.xml`, "-DskipTests", "compile"],
  frameworkDir
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--framework-dir") {
      parsed.frameworkDir = argv[++index];
    } else if (arg === "--smoke-name") {
      parsed.smokeName = argv[++index];
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function usage(message) {
  const scriptName = path.basename(fileURLToPath(import.meta.url));
  console.error(message);
  console.error(`Usage: node scripts/${scriptName} --framework-dir /path/to/pipelineframework-tag-worktree`);
  process.exit(2);
}

function validateSmokeName(value) {
  if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) {
    usage(`Invalid smoke name: ${value}. Use a simple directory name without path traversal or separators.`);
  }
}

function validateSchema(label, schema, value) {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(`${label} failed schema validation:\n${details}`);
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with status ${code}`));
      }
    });
  });
}

function buildCheckpointConfig() {
  return {
    version: 2,
    appName: "CheckpointComposition",
    basePackage: "com.example.checkpointcomposition",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    input: {
      subscription: {
        publication: "payments.validated"
      }
    },
    output: {
      checkpoint: {
        publication: "settlements.ready",
        idempotencyKeyFields: ["settlementId"]
      }
    },
    messages: {
      PaymentValidated: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" },
          { number: 3, name: "currency", type: "string" }
        ]
      },
      SettlementPrepared: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "settlementId", type: "uuid" },
          { number: 3, name: "amount", type: "decimal" },
          { number: 4, name: "currency", type: "string" }
        ]
      },
      SettlementReady: {
        fields: [
          { number: 1, name: "settlementId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      }
    },
    steps: [
      {
        name: "Prepare Settlement",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PaymentValidated",
        outputTypeName: "SettlementPrepared"
      },
      {
        name: "Mark Settlement Ready",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "SettlementPrepared",
        outputTypeName: "SettlementReady"
      }
    ]
  };
}

function buildCompositionManifest(smokeName) {
  return {
    version: 1,
    name: "payment-settlement-composition",
    pipelines: [
      { id: "payment-validation", path: "../payment-validation/config/pipeline.yaml" },
      { id: "settlement-preparation", path: "config/pipeline.yaml" },
      { id: "settlement-posting", path: "../settlement-posting/config/pipeline.yaml" }
    ]
  };
}
