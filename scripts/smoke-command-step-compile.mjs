#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { generateScaffold } from "../dist/src/template-bridge.js";

const DEFAULT_SMOKE_NAME = "command-step-smoke";

const args = parseArgs(process.argv.slice(2));
const frameworkDir = path.resolve(args.frameworkDir || process.env.TPF_FRAMEWORK_DIR || ".");
const smokeName = args.smokeName || process.env.TPF_SMOKE_NAME || DEFAULT_SMOKE_NAME;
if (!smokeName || smokeName.includes("..") || smokeName.includes("/") || smokeName.includes("\\")) {
  throw new Error(`Unsafe smoke name '${smokeName}'. Use a plain directory name without path traversal.`);
}
const outputDir = path.join(frameworkDir, "examples", smokeName);

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

await generateScaffold(buildCommandStepConfig(), outputDir);

await assertGeneratedFiles(outputDir);

const mvnw = path.join(frameworkDir, process.platform === "win32" ? "mvnw.cmd" : "mvnw");
execFileSync(mvnw, ["-f", path.join(outputDir, "pom.xml"), "-DskipTests", "compile"], {
  cwd: frameworkDir,
  stdio: "inherit"
});

console.log(`Command step scaffold smoke compiled at ${outputDir}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--framework-dir") {
      parsed.frameworkDir = argv[++index];
    } else if (arg === "--smoke-name") {
      parsed.smokeName = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function assertGeneratedFiles(rootDir) {
  const pipelineYaml = await fs.readFile(path.join(rootDir, "config", "pipeline.yaml"), "utf8");
  assert.match(pipelineYaml, /kind: command/);
  assert.match(pipelineYaml, /command: opensearch-index-document/);
  assert.match(pipelineYaml, /commandIdGenerator: com\.example\.commandstepsmoke\.common\.command\.SearchIndexDocumentCommandIdGenerator/);
  assert.match(pipelineYaml, /duplicatePolicy: RETURN_RECORDED/);

  const appProperties = await fs.readFile(path.join(rootDir, "orchestrator-svc", "src/main/resources/application.properties"), "utf8");
  assert.match(appProperties, /pipeline\.orchestrator\.mode=QUEUE_ASYNC/);
  assert.match(appProperties, /Keep command connectors idempotent over deterministic command ids/);

  await fs.access(path.join(rootDir, "build-search-document-svc", "pom.xml"));
  await fs.access(path.join(rootDir, "summarize-search-write-svc", "pom.xml"));
  await assert.rejects(
    () => fs.access(path.join(rootDir, "write-search-index-document-svc", "pom.xml")),
    /ENOENT/
  );
  await fs.access(path.join(rootDir, "common/src/main/java/com/example/commandstepsmoke/common/command/SearchIndexDocumentCommandIdGenerator.java"));
  await fs.access(path.join(rootDir, "common/src/main/java/com/example/commandstepsmoke/common/command/OpensearchIndexDocumentCommandConnector.java"));
}

function buildCommandStepConfig() {
  return {
    version: 2,
    appName: "CommandStepSmoke",
    basePackage: "com.example.commandstepsmoke",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      RawDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "content", type: "string" }
        ]
      },
      SearchIndexDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "indexName", type: "string" },
          { number: 3, name: "body", type: "string" }
        ]
      },
      SearchIndexWriteResult: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "written", type: "bool" }
        ]
      },
      IndexAck: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      }
    },
    steps: [
      {
        name: "Build Search Document",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "RawDocument",
        outputTypeName: "SearchIndexDocument"
      },
      {
        name: "Write Search Index Document",
        kind: "command",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "SearchIndexDocument",
        outputTypeName: "SearchIndexWriteResult",
        command: "opensearch-index-document",
        commandIdGenerator: "com.example.commandstepsmoke.common.command.SearchIndexDocumentCommandIdGenerator",
        duplicatePolicy: "RETURN_RECORDED",
        config: {
          indexName: "documents"
        }
      },
      {
        name: "Summarize Search Write",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "SearchIndexWriteResult",
        outputTypeName: "IndexAck"
      }
    ]
  };
}
