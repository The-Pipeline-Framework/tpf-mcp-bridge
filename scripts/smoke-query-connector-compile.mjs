import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "query-connector-smoke";

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
await generateScaffold(buildQueryConnectorConfig(), outputDir);

const queryServiceModulePath = path.join(outputDir, "load-customer-risk-svc");
if (existsSync(queryServiceModulePath)) {
  throw new Error(`Generated scaffold contains a service module for the query boundary: ${queryServiceModulePath}`);
}

const pipelineYaml = readFileSync(path.join(outputDir, "config", "pipeline.yaml"), "utf8");
for (const expected of [
  "kind: query",
  "query: customer-risk-by-id",
  "connector: jpa",
  "entity: com.example.queryconnectorsmoke.common.domain.CustomerRiskEntity",
  "customerId:",
  "eq: input.customerId",
  "gte: 0",
  "orderBy:",
  "score: desc",
  "limit: 1",
]) {
  if (!pipelineYaml.includes(expected)) {
    throw new Error(`Generated query connector pipeline.yaml is missing '${expected}'.`);
  }
}

const orchestratorPom = readFileSync(path.join(outputDir, "orchestrator-svc", "pom.xml"), "utf8");
if (!orchestratorPom.includes("query-jpa-connector")) {
  throw new Error("Generated query connector orchestrator POM is missing query-jpa-connector.");
}

const applicationProperties = readFileSync(
  path.join(outputDir, "orchestrator-svc", "src", "main", "resources", "application.properties"),
  "utf8"
);
for (const expected of [
  "quarkus.datasource.db-kind=${TPF_QUERY_JPA_DB_KIND:postgresql}",
  "%dev.quarkus.datasource.devservices.enabled=true",
  "%test.quarkus.datasource.devservices.enabled=true",
]) {
  if (!applicationProperties.includes(expected)) {
    throw new Error(`Generated query connector application.properties is missing '${expected}'.`);
  }
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

function buildQueryConnectorConfig() {
  return {
    version: 2,
    appName: "QueryConnectorSmoke",
    basePackage: "com.example.queryconnectorsmoke",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      CustomerRiskLookup: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" }
        ]
      },
      CustomerRiskSnapshot: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" },
          { number: 2, name: "riskBand", type: "string" },
          { number: 3, name: "score", type: "decimal" }
        ]
      },
      CustomerDecision: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" },
          { number: 2, name: "approved", type: "bool" },
          { number: 3, name: "riskBand", type: "string" }
        ]
      }
    },
    queries: {
      "customer-risk-by-id": {
        connector: "jpa",
        inputType: "CustomerRiskLookup",
        outputType: "CustomerRiskSnapshot",
        version: "v1",
        jpa: {
          entity: "com.example.queryconnectorsmoke.common.domain.CustomerRiskEntity",
          where: {
            customerId: {
              eq: "input.customerId"
            },
            score: {
              gte: 0
            },
            riskBand: {
              in: ["LOW", "MEDIUM", "HIGH"]
            }
          },
          projection: {
            customerId: "customerId",
            riskBand: "riskBand",
            score: "score"
          },
          orderBy: {
            score: "desc"
          },
          limit: 1,
          result: "single"
        }
      }
    },
    steps: [
      {
        name: "Load Customer Risk",
        kind: "query",
        cardinality: "ONE_TO_ONE",
        query: "customer-risk-by-id",
        inputTypeName: "CustomerRiskLookup",
        outputTypeName: "CustomerRiskSnapshot",
        capture: {
          keyFields: ["customerId"]
        }
      },
      {
        name: "Classify Customer",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "CustomerRiskSnapshot",
        outputTypeName: "CustomerDecision"
      }
    ]
  };
}
