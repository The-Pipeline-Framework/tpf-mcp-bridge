import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "kafka-await-smoke";

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
await generateScaffold(buildKafkaAwaitConfig(), outputDir);

const awaitServiceModulePath = path.join(outputDir, "await-payment-provider-svc");
if (existsSync(awaitServiceModulePath)) {
  throw new Error(`Generated scaffold contains a service module for the await boundary: ${awaitServiceModulePath}`);
}

const applicationProperties = readFileSync(
  path.join(outputDir, "orchestrator-svc", "src", "main", "resources", "application.properties"),
  "utf8"
);
for (const expected of [
  "tpf.await.kafka.reactive-messaging.enabled=true",
  "mp.messaging.outgoing.tpf-await-kafka-requests.topic=payment.requests",
  "mp.messaging.incoming.tpf-await-kafka-responses.topic=payment.results",
]) {
  if (!applicationProperties.includes(expected)) {
    throw new Error(`Generated Kafka await application.properties is missing '${expected}'.`);
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

function buildKafkaAwaitConfig() {
  return {
    version: 2,
    appName: "KafkaAwait",
    basePackage: "com.example.kafkaawait",
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
            type: "kafka",
            request: { topic: "payment.requests" },
            response: { topic: "payment.results" },
            consumer: { group: "payment-await-orchestrator" }
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
