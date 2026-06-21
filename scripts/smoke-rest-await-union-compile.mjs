import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "restaurant-approval-union-smoke";

const args = parseArgs(process.argv.slice(2));
const frameworkDirArg = args.frameworkDir || process.env.TPF_FRAMEWORK_DIR;
const smokeName = args.smokeName || process.env.TPF_SMOKE_NAME || DEFAULT_SMOKE_NAME;

if (!frameworkDirArg) {
  usage("Missing --framework-dir or TPF_FRAMEWORK_DIR.");
}

const frameworkDir = path.resolve(frameworkDirArg);

if (!existsSync(path.join(frameworkDir, "pom.xml"))) {
  usage(`Framework directory does not contain a root pom.xml: ${frameworkDir}`);
}

const outputDir = path.join(frameworkDir, "examples", smokeName);
await rm(outputDir, { recursive: true, force: true });
await generateScaffold(buildRestaurantApprovalUnionConfig(), outputDir);

const legacyConfigPath = path.join(outputDir, "pipeline-config.yaml");
if (existsSync(legacyConfigPath)) {
  throw new Error(`Generated scaffold contains legacy duplicate pipeline config: ${legacyConfigPath}`);
}

const awaitServiceModulePath = path.join(outputDir, "await-restaurant-decision-svc");
if (existsSync(awaitServiceModulePath)) {
  throw new Error(`Generated scaffold contains a service module for the await boundary: ${awaitServiceModulePath}`);
}

const generatedServices = findFiles(outputDir, /^Process.*Service\.java$/);
if (generatedServices.length === 0) {
  throw new Error("Generated scaffold did not contain any business service stubs.");
}
for (const servicePath of generatedServices) {
  const source = readFileSync(servicePath, "utf8");
  if (source.includes("runOnVirtualThreads")) {
    throw new Error(`Generated service still references removed @PipelineStep runOnVirtualThreads attribute: ${servicePath}`);
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

function findFiles(root, pattern) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(entryPath, pattern));
    } else if (pattern.test(entry.name)) {
      found.push(entryPath);
    }
  }
  return found;
}

function buildRestaurantApprovalUnionConfig() {
  return {
    version: 2,
    appName: "RestaurantApproval",
    basePackage: "com.example.restaurantapproval",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    messages: {
      PendingRestaurantApproval: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "restaurantName", type: "string" }
        ]
      },
      RestaurantOrderAccepted: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "decidedAt", type: "timestamp" },
          { number: 3, name: "note", type: "string" }
        ]
      },
      RestaurantOrderDeclined: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "decidedAt", type: "timestamp" },
          { number: 3, name: "note", type: "string" },
          { number: 4, name: "declineReason", type: "string" }
        ]
      },
      TerminalOrderState: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "outcome", type: "string" }
        ]
      }
    },
    unions: {
      RestaurantDecision: {
        variants: {
          accepted: { number: 1, type: "RestaurantOrderAccepted" },
          declined: { number: 2, type: "RestaurantOrderDeclined" }
        }
      }
    },
    steps: [
      {
        name: "Await Restaurant Decision",
        kind: "await",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PendingRestaurantApproval",
        outputTypeName: "RestaurantDecision",
        timeout: "PT30M",
        idempotencyKeyFields: ["orderId"],
        await: {
          correlation: { strategy: "interactionId" },
          transport: { type: "interaction-api" }
        }
      },
      {
        name: "Finalize Restaurant Decision",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "RestaurantDecision",
        outputTypeName: "TerminalOrderState"
      }
    ]
  };
}
