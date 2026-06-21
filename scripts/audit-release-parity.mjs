/*
 * Copyright (c) 2023-2025 Mariano Barcia
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATEGORY_ORDER = [
  "fix now",
  "defer issue",
  "needs human review",
  "added file follow-up",
  "covered",
  "no scaffold impact",
];

const DEFAULT_FROM = "v26.6.1";
const DEFAULT_TO = "HEAD";

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const entries = options.diffFile
  ? parseNameStatus(fs.readFileSync(options.diffFile, "utf8"))
  : readGitDiff(options);
const findings = entries.map(classifyEntry);
const report = renderReport({
  from: options.from,
  to: options.to,
  frameworkDir: options.frameworkDir,
  source: options.diffFile ? options.diffFile : "git diff --name-status",
  findings,
});

if (options.output) {
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, report);
  console.log(`Wrote release parity audit report to ${options.output}`);
} else {
  process.stdout.write(report);
}

function parseArgs(args) {
  const parsed = {
    from: DEFAULT_FROM,
    to: DEFAULT_TO,
    frameworkDir: process.env.TPF_FRAMEWORK_DIR
      ? path.resolve(process.env.TPF_FRAMEWORK_DIR)
      : path.resolve(repoRoot, "../pipelineframework"),
    diffFile: undefined,
    output: undefined,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--from":
        parsed.from = requireValue(args, ++index, arg);
        break;
      case "--to":
        parsed.to = requireValue(args, ++index, arg);
        break;
      case "--framework-dir":
        parsed.frameworkDir = path.resolve(requireValue(args, ++index, arg));
        break;
      case "--diff-file":
        parsed.diffFile = path.resolve(requireValue(args, ++index, arg));
        break;
      case "--output":
        parsed.output = path.resolve(requireValue(args, ++index, arg));
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument '${arg}'. Run npm run audit:release-parity -- --help for usage.`);
    }
  }

  return parsed;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`TPF MCP release parity audit

Usage:
  npm run audit:release-parity -- --framework-dir ../pipelineframework
  npm run audit:release-parity -- --from v26.6.1 --to HEAD --framework-dir ../pipelineframework --output reports/parity.md

Options:
  --from <ref>           Previous TPF release tag/ref. Default: ${DEFAULT_FROM}
  --to <ref>             Target TPF release tag/ref. Default: ${DEFAULT_TO}
  --framework-dir <dir>  External pipelineframework checkout. Default: $TPF_FRAMEWORK_DIR or ../pipelineframework
  --diff-file <file>     Read git diff --name-status output from a fixture file instead of running git
  --output <file>        Write Markdown report to a file instead of stdout
`);
}

function readGitDiff({ frameworkDir, from, to }) {
  if (!fs.existsSync(path.join(frameworkDir, ".git"))) {
    throw new Error(
      `Framework checkout not found at ${frameworkDir}. ` +
      "Pass --framework-dir <path-to-pipelineframework> or set TPF_FRAMEWORK_DIR."
    );
  }
  const output = execFileSync("git", ["diff", "--name-status", `${from}..${to}`], {
    cwd: frameworkDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parseNameStatus(output);
}

function parseNameStatus(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split(/\t+/);
      const kind = status.slice(0, 1);
      return {
        status,
        kind,
        path: paths.length > 1 ? paths[paths.length - 1] : paths[0],
        oldPath: paths.length > 1 ? paths[0] : undefined,
      };
    });
}

function classifyEntry(entry) {
  const filePath = normalizePath(entry.path);
  const oldPath = entry.oldPath ? normalizePath(entry.oldPath) : undefined;
  const subject = `${filePath} ${oldPath ?? ""}`.toLowerCase();
  const notes = [];
  let category = "no scaffold impact";
  let owner = "docs/non-runtime";

  if (isPipelineTemplateSchema(filePath)) {
    category = "fix now";
    owner = "deployment schema";
    notes.push("Sync the vendored generator schema and run check:pipeline-schema against this release candidate.");
    notes.push("Inspect schema additions such as query, object source/publish, and YAML-owned execution flags.");
  } else if (isGeneratedCompileBreakSurface(filePath)) {
    category = "fix now";
    owner = ownerFor(filePath);
    notes.push("Framework authoring/runtime API changed; generated Java/templates must compile against the release candidate.");
  } else if (entry.kind === "A" && isScaffoldRelevant(filePath)) {
    owner = ownerFor(filePath);
    if (isProductScopeSurface(filePath)) {
      category = "defer issue";
      notes.push("New product surface; create or update a scoped follow-up issue instead of silently adding scaffold behavior.");
    } else {
      category = "added file follow-up";
      notes.push("Added release files need a second-pass review; new runtime concepts often enter through new packages/examples.");
    }
  } else if (isCompositionSchema(filePath)) {
    category = "needs human review";
    owner = "composition schema";
    notes.push("Composition schema is a reference snapshot; confirm code-level invariants and sidecar tests still match.");
  } else if (isExampleConfig(filePath)) {
    category = "needs human review";
    owner = "canonical examples";
    notes.push("Example config/POM/property changes may encode scaffold defaults or required starter dependencies.");
  } else if (isDeploymentRuntimeSurface(filePath) || isRuntimeRootHighSignal(filePath)) {
    category = "needs human review";
    owner = ownerFor(filePath);
    notes.push("Framework compile/runtime surface changed; check planner, validation, templates, and compile smokes.");
  } else if (isHighSignalDoc(filePath)) {
    category = "needs human review";
    owner = "release docs";
    notes.push("User-facing runtime/build docs changed; inspect for scaffold semantics that are not schema-visible.");
  }

  if (subject.includes("sqs")) {
    notes.push("SQS surface changed; confirm generated properties, dependencies, and smoke coverage.");
  }
  if (subject.includes("composition") || subject.includes("checkpoint")) {
    notes.push("Composition/checkpoint surface changed; confirm pipeline.yaml and pipeline-composition.yaml generation.");
    notes.push("Follow-up coverage is tracked by #25.");
  }
  if (subject.includes("runtime-core")) {
    notes.push("Runtime-core split touched; confirm generated dependency assumptions still hold.");
    notes.push("Dependency/layout audit is tracked by #28.");
  }
  if (subject.includes("spring")) {
    notes.push("Spring adapter surface touched; decide whether scaffold support is in scope or explicitly deferred.");
    notes.push("Spring scaffold scope is tracked by #26.");
  }
  if (subject.includes("query")) {
    notes.push("Query connector/surface touched; decide whether MCP should model it or defer product scope.");
    notes.push("Query connector scaffold scope is tracked by #31.");
  }
  if (subject.includes("object-ingest") || subject.includes("objectsource") || subject.includes("object-source")) {
    notes.push("Object ingest/source surface touched; decide whether scaffold support is product scope or docs-only.");
    notes.push("Object-ingest connector scaffold scope is tracked by #30.");
  }
  if (subject.includes("runonvirtualthreads") || subject.includes("blocking")) {
    notes.push("Blocking or virtual-thread authoring changed; generated service templates must avoid stale annotation attributes.");
  }
  if (subject.includes("self-host") || subject.includes("worker") || subject.includes("controlplane") || subject.includes("control-plane")) {
    notes.push("Self-host/coordinator/worker surface touched; confirm this is docs-only or add generator guidance.");
    notes.push("Self-host/coordinator/worker scope is tracked by #27.");
  }
  if (category === "no scaffold impact") {
    notes.length = 0;
  }

  return {
    ...entry,
    path: filePath,
    oldPath,
    category,
    owner,
    notes: [...new Set(notes)],
  };
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function isScaffoldRelevant(filePath) {
  return isPipelineTemplateSchema(filePath)
    || isCompositionSchema(filePath)
    || isExampleConfig(filePath)
    || isSelfHostExampleSurface(filePath)
    || isConnectorSurface(filePath)
    || isSpringSmokeSurface(filePath)
    || isDeploymentRuntimeSurface(filePath)
    || isRuntimeRootHighSignal(filePath)
    || isHighSignalDoc(filePath);
}

function isPipelineTemplateSchema(filePath) {
  return filePath === "framework/deployment/src/main/resources/META-INF/pipeline/pipeline-template-schema.json";
}

function isCompositionSchema(filePath) {
  return filePath === "framework/runtime/src/main/resources/META-INF/pipeline/pipeline-composition-schema.json";
}

function isExampleConfig(filePath) {
  return /^examples\/[^/]+\/.*(?:pipeline(?:\.[^/]+)?\.ya?ml|application\.properties|pom\.xml)$/.test(filePath)
    || /^examples\/[^/]+\/config\/.*\.ya?ml$/.test(filePath);
}

function isConnectorSurface(filePath) {
  return /^connectors\/(?:object-ingest|query-jpa)\//.test(filePath)
    || /^docs\/guide\/connectors\//.test(filePath);
}

function isSpringSmokeSurface(filePath) {
  return /^framework\/spring-blocking-smoke-tests\//.test(filePath);
}

function isSelfHostExampleSurface(filePath) {
  return /^examples\/[^/]+\/self-host\//.test(filePath)
    || /^examples\/[^/]+\/.*\/self-host\//.test(filePath);
}

function isGeneratedCompileBreakSurface(filePath) {
  return filePath === "framework/runtime/src/main/java/org/pipelineframework/annotation/PipelineStep.java"
    || /framework\/deployment\/src\/main\/java\/org\/pipelineframework\/processor\/(?:parser\/StepDefinitionParser|ir\/StepDefinition|schema\/PipelineTemplateSchemaExporter|phase\/ModelExtractionPhase)\.java$/.test(filePath)
    || /^framework\/runtime\/src\/main\/java\/org\/pipelineframework\/blocking\//.test(filePath);
}

function isProductScopeSurface(filePath) {
  return isConnectorSurface(filePath) || isSpringSmokeSurface(filePath);
}

function isDeploymentRuntimeSurface(filePath) {
  return /^framework\/deployment\/src\/main\/java\/org\/pipelineframework\/processor\//.test(filePath)
    || /^framework\/runtime(?:-core|-spring)?\/pom\.xml$/.test(filePath)
    || /^framework\/runtime(?:-core|-spring)?\/src\/main\/java\/org\/pipelineframework\/(?:awaitable|checkpoint|config|invocation|orchestrator|runtime|proto)\//.test(filePath)
    || /^framework\/runtime\/src\/main\/proto\//.test(filePath);
}

function isRuntimeRootHighSignal(filePath) {
  return /^framework\/runtime\/src\/main\/java\/org\/pipelineframework\/(?:Await|LocalPipelineControlPlane|PipelineExecutionService|PipelineJson|PipelineOrchestratorConfig|PipelineRunner|PipelineStepExecutor|PipelineStepResolver|QueueAsync|RuntimeAdapter)/.test(filePath);
}

function isHighSignalDoc(filePath) {
  return /^(docs\/guide\/(?:build|development\/orchestrator-runtime|operations|plugins|connectors)\/|docs\/(?:deploy|develop|design|evolve)\/)/.test(filePath)
    && /(await|queue|checkpoint|composition|runtime|configuration|persistence|caching|operators|replay|self-host|spring|blocking|connector|query|object|source|publish)/i.test(filePath);
}

function ownerFor(filePath) {
  if (filePath.includes("/deployment/")) {
    return "deployment/compiler";
  }
  if (filePath.includes("/runtime-core/")) {
    return "runtime-core";
  }
  if (filePath.includes("/runtime-spring/")) {
    return "spring runtime adapter";
  }
  if (filePath.startsWith("connectors/object-ingest/")) {
    return "object ingest connector";
  }
  if (filePath.startsWith("connectors/query-jpa/")) {
    return "query connector";
  }
  if (filePath.startsWith("framework/spring-blocking-smoke-tests/")) {
    return "spring blocking smoke";
  }
  if (filePath.includes("/runtime/")) {
    return "runtime/orchestrator";
  }
  if (filePath.startsWith("examples/")) {
    return "canonical examples";
  }
  if (filePath.startsWith("docs/")) {
    return "release docs";
  }
  return "scaffold surface";
}

function renderReport({ from, to, frameworkDir, source, findings }) {
  const relevant = findings.filter((finding) => finding.category !== "no scaffold impact");
  const ignored = findings.filter((finding) => finding.category === "no scaffold impact");
  const lines = [
    `# TPF MCP Release Parity Audit`,
    "",
    `- Baseline: \`${from}..${to}\``,
    `- Framework checkout: \`${frameworkDir}\``,
    `- Source: \`${source}\``,
    `- Files inspected: ${findings.length}`,
    `- Scaffold-relevant findings: ${relevant.length}`,
    "",
    "## Required Follow-Up",
    "",
    "- Inspect open and draft MCP bridge PRs before starting release parity work.",
    "- Treat `fix now` items as release blockers for scaffold/MCP parity.",
    "- Convert `defer issue` items into explicit GitHub issues or update existing ones.",
    "- Treat added files as a second-pass review queue; do not rely on schema drift alone.",
    "- Choose or update generated-scaffold compile smokes for every runtime/config surface accepted into scope.",
    "",
  ];

  for (const category of CATEGORY_ORDER) {
    const categoryFindings = findings.filter((finding) => finding.category === category);
    if (categoryFindings.length === 0) {
      continue;
    }

    lines.push(`## ${titleCase(category)}`, "");
    const displayedFindings = category === "no scaffold impact"
      ? categoryFindings.slice(0, 25)
      : categoryFindings;
    for (const finding of displayedFindings) {
      lines.push(`- \`${finding.status}\` \`${finding.path}\` (${finding.owner})`);
      if (finding.oldPath) {
        lines.push(`  - renamed from \`${finding.oldPath}\``);
      }
      for (const note of finding.notes) {
        lines.push(`  - ${note}`);
      }
    }
    if (displayedFindings.length < categoryFindings.length) {
      lines.push(`- ... ${categoryFindings.length - displayedFindings.length} additional low-signal files omitted.`);
    }
    lines.push("");
  }

  if (ignored.length === 0) {
    lines.push("## No Scaffold Impact", "", "- No docs-only or unrelated files were ignored.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function titleCase(value) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
