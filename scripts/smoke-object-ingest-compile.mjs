import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "object-ingest-smoke";

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
await generateScaffold(buildObjectIngestConfig(), outputDir);

const pipelineYaml = readFileSync(path.join(outputDir, "config", "pipeline.yaml"), "utf8");
for (const expected of [
  "sources:",
  "documents:",
  "provider: filesystem",
  "input:",
  "object:",
  "source: documents",
  "typeName: RawDocument",
  "mapper: com.example.objectingestsmoke.common.mapper.RawDocumentObjectSnapshotMapper",
]) {
  if (!pipelineYaml.includes(expected)) {
    throw new Error(`Generated object ingest pipeline.yaml is missing '${expected}'.`);
  }
}

const orchestratorPom = readFileSync(path.join(outputDir, "orchestrator-svc", "pom.xml"), "utf8");
if (!orchestratorPom.includes("object-ingest-connector")) {
  throw new Error("Generated object ingest orchestrator POM is missing object-ingest-connector.");
}

const mapperPath = path.join(
  outputDir,
  "common",
  "src",
  "main",
  "java",
  "com",
  "example",
  "objectingestsmoke",
  "common",
  "mapper",
  "RawDocumentObjectSnapshotMapper.java"
);
const mapper = readFileSync(mapperPath, "utf8");
if (!mapper.includes("implements ObjectSnapshotMapper<RawDocument>")) {
  throw new Error("Generated object snapshot mapper does not implement ObjectSnapshotMapper<RawDocument>.");
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

function buildObjectIngestConfig() {
  return {
    version: 2,
    appName: "ObjectIngestSmoke",
    basePackage: "com.example.objectingestsmoke",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    sources: {
      documents: {
        kind: "object",
        provider: "filesystem",
        location: {
          root: "/tmp/tpf-object-ingest-smoke"
        },
        filter: {
          include: ["**/*.txt", "**/*.md"]
        },
        poll: {
          enabled: true,
          interval: "PT30S",
          batchSize: 25
        },
        payload: {
          mode: "text",
          maxBytes: 1048576,
          charset: "UTF-8"
        }
      }
    },
    input: {
      object: {
        source: "documents",
        emits: {
          type: "com.example.objectingestsmoke.common.domain.RawDocument",
          typeName: "RawDocument",
          mapper: "com.example.objectingestsmoke.common.mapper.RawDocumentObjectSnapshotMapper"
        }
      }
    },
    messages: {
      RawDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "content", type: "string" }
        ]
      },
      ParsedDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "tokenCount", type: "int32" }
        ]
      }
    },
    steps: [
      {
        name: "Parse Document",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "RawDocument",
        outputTypeName: "ParsedDocument",
        inboundMapper: "com.example.objectingestsmoke.common.mapper.RawDocumentMapper"
      }
    ]
  };
}
