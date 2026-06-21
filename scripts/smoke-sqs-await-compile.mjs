import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "sqs-await-smoke";

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
await generateScaffold(buildSqsAwaitConfig(), outputDir);

const awaitServiceModulePath = path.join(outputDir, "await-payment-provider-svc");
if (existsSync(awaitServiceModulePath)) {
  throw new Error(`Generated scaffold contains a service module for the await boundary: ${awaitServiceModulePath}`);
}

const pipelineYaml = readFileSync(path.join(outputDir, "config", "pipeline.yaml"), "utf8");
for (const expected of [
  "type: sqs",
  "queueUrl: https://sqs.us-east-1.amazonaws.com/123456789012/payment-requests",
  "queueUrl: https://sqs.us-east-1.amazonaws.com/123456789012/payment-results",
]) {
  if (!pipelineYaml.includes(expected)) {
    throw new Error(`Generated SQS await pipeline.yaml is missing '${expected}'.`);
  }
}

const orchestratorPom = readFileSync(path.join(outputDir, "orchestrator-svc", "pom.xml"), "utf8");
if (!orchestratorPom.includes("quarkus-amazon-sqs")) {
  throw new Error("Generated SQS await orchestrator POM is missing quarkus-amazon-sqs.");
}

const applicationProperties = readFileSync(
  path.join(outputDir, "orchestrator-svc", "src", "main", "resources", "application.properties"),
  "utf8"
);
for (const expected of [
  "tpf.await.sqs.poller.enabled=true",
  "tpf.await.sqs.request-queue-url=${TPF_AWAIT_SQS_REQUEST_QUEUE_URL}",
  "tpf.await.sqs.response-queue-url=${TPF_AWAIT_SQS_RESPONSE_QUEUE_URL}",
  "quarkus.sqs.aws.region=${AWS_REGION:us-east-1}",
]) {
  if (!applicationProperties.includes(expected)) {
    throw new Error(`Generated SQS await application.properties is missing '${expected}'.`);
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

function buildSqsAwaitConfig() {
  return {
    version: 2,
    appName: "SqsAwait",
    basePackage: "com.example.sqsawait",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      PaymentRequest: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ]
      },
      PaymentValidated: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ]
      },
      PaymentProviderResult: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      },
      PaymentFinalized: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      }
    },
    steps: [
      {
        name: "Validate Payment Request",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PaymentRequest",
        outputTypeName: "PaymentValidated"
      },
      {
        name: "Await Payment Provider",
        kind: "await",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PaymentValidated",
        outputTypeName: "PaymentProviderResult",
        timeout: "PT5M",
        idempotencyKeyFields: ["paymentId"],
        await: {
          correlation: { strategy: "interactionId" },
          transport: {
            type: "sqs",
            request: { queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/payment-requests" },
            response: { queueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/payment-results" }
          }
        }
      },
      {
        name: "Finalize Payment",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PaymentProviderResult",
        outputTypeName: "PaymentFinalized"
      }
    ]
  };
}
