import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initializeRefreshCheckouts,
  validateRepowiseHealth,
  writeRefreshConfiguration,
} from "../src/repowise-refresh.js";

const args = parseArgs(process.argv.slice(2));
const bridgeDir = realpathSync(path.resolve("."));
const stateDir = stateDirFor(args);
requireExternalStateDirectory(args.frameworkDir, stateDir);
const tsxCli = path.join(bridgeDir, "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(tsxCli)) {
  throw new Error(
    `TypeScript runner not found at ${tsxCli}; run npm ci before installing hooks`,
  );
}
const { healthyDir, candidateDir } = initializeRefreshCheckouts(
  args.frameworkDir,
  stateDir,
);
seedHealthyIndex(args.frameworkDir, healthyDir);
writeRefreshConfiguration(stateDir, {
  schemaVersion: 1,
  bridgeDir,
  healthyDir,
  candidateDir,
  environment: args.environment,
});

for (const hook of ["post-commit", "post-merge", "post-checkout"] as const) {
  installRefreshHook(hook);
}
console.log(
  `Installed dedicated, health-gated Repowise refresh hooks (${args.environment}) using ${healthyDir}.`,
);

function seedHealthyIndex(sourceDir: string, targetDir: string): void {
  const sourceIndex = path.join(sourceDir, ".repowise");
  const targetIndex = path.join(targetDir, ".repowise");
  if (!existsSync(sourceIndex) || existsSync(targetIndex)) return;
  const temporaryIndex = `${targetIndex}.seed.${process.pid}`;
  try {
    const report = JSON.parse(
      execFileSync(
        "repowise",
        ["doctor", "--no-workspace", "--format", "json"],
        { cwd: sourceDir, encoding: "utf8" },
      ),
    ) as unknown;
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      encoding: "utf8",
    }).trim();
    const sourceStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: sourceDir,
      encoding: "utf8",
    });
    if (sourceStatus.trim() !== "") {
      throw new Error("active framework checkout is dirty");
    }
    const state = JSON.parse(
      readFileSync(path.join(sourceIndex, "state.json"), "utf8"),
    ) as { last_sync_commit?: string; last_sync?: string };
    validateRepowiseHealth(
      report,
      state.last_sync_commit ?? state.last_sync ?? "",
      sourceCommit,
    );
    rmSync(temporaryIndex, { recursive: true, force: true });
    cpSync(sourceIndex, temporaryIndex, { recursive: true });
    removeTransientUploadState(temporaryIndex);
    renameSync(temporaryIndex, targetIndex);
  } catch (error) {
    rmSync(temporaryIndex, { recursive: true, force: true });
    // A missing or unhealthy active index is never a seed. The first request
    // will build a clean candidate without replacing any healthy state.
    console.warn(`Skipped active Repowise seed: ${errorMessage(error)}`);
  }
}

function removeTransientUploadState(indexDirectory: string): void {
  const queue = path.join(indexDirectory, "tpf-mcp-upload-queue");
  if (!existsSync(queue)) return;
  rmSync(path.join(queue, ".upload.lock"), { force: true });
  for (const entry of readdirSync(queue)) {
    if (entry.startsWith(".staging-")) {
      rmSync(path.join(queue, entry), { recursive: true, force: true });
    }
  }
}

function installRefreshHook(
  name: "post-commit" | "post-merge" | "post-checkout",
): void {
  const target = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`],
    { cwd: args.frameworkDir, encoding: "utf8" },
  ).trim();
  const existing = existsSync(target)
    ? readFileSync(target, "utf8")
    : "#!/bin/sh\n";
  const withoutManagedBlocks = removeManagedBlocks(existing);
  const branchGuard = [
    "ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    `[ "$ROOT" = ${shellQuote(args.frameworkDir)} ] || exit 0`,
    name === "post-checkout" ? `[ "\${3:-0}" = '1' ] || exit 0` : "",
    `BRANCH=$(git -C ${shellQuote(args.frameworkDir)} branch --show-current 2>/dev/null) || exit 0`,
    `[ "$BRANCH" = 'main' ] || exit 0`,
    `HEAD=$(git -C ${shellQuote(args.frameworkDir)} rev-parse HEAD 2>/dev/null) || exit 0`,
    `mkdir -p ${shellQuote(stateDir)}`,
    `(${shellQuote(process.execPath)} ${shellQuote(tsxCli)} ${shellQuote(path.join(bridgeDir, "scripts", "refresh-repowise.ts"))} --state-dir ${shellQuote(stateDir)} --commit "$HEAD" >> ${shellQuote(path.join(stateDir, "refresh.log"))} 2>&1) &`,
  ]
    .filter((line) => line !== "")
    .join("\n");
  const block = `# tpf-mcp-refresh-start\n${branchGuard}\n# tpf-mcp-refresh-end\n`;
  writeFileSync(target, insertAfterShebang(withoutManagedBlocks, block), {
    mode: 0o755,
  });
  chmodSync(target, 0o755);
}

function removeManagedBlocks(hook: string): string {
  return hook
    .replace(
      /^[ \t]*# tpf-mcp-(?:upload|post-merge|post-checkout|refresh)-start[\s\S]*?^[ \t]*# tpf-mcp-(?:upload|post-merge|post-checkout|refresh)-end\n?/gm,
      "",
    )
    .replace(/\n{3,}/g, "\n\n");
}

function insertAfterShebang(hook: string, block: string): string {
  const normalized = hook.startsWith("#!") ? hook : `#!/bin/sh\n${hook}`;
  const newline = normalized.indexOf("\n");
  if (newline === -1) return `${normalized}\n${block}`;
  return `${normalized.slice(0, newline + 1)}${block}${normalized.slice(newline + 1)}`;
}

function parseArgs(values: string[]) {
  const parsed: {
    frameworkDir: string;
    stateDir?: string;
    environment: "staging" | "production";
  } = {
    frameworkDir: "",
    environment: "production",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--framework-dir")
      parsed.frameworkDir = realpathSync(
        path.resolve(requireValue(values, ++index, value)),
      );
    else if (value === "--state-dir")
      parsed.stateDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--environment") {
      const environment = requireValue(values, ++index, value);
      if (environment !== "staging" && environment !== "production")
        throw new Error("environment must be staging or production");
      parsed.environment = environment;
    } else throw new Error(`Unknown argument '${value}'`);
  }
  if (parsed.frameworkDir === "") {
    throw new Error(
      "Usage: npm run install:repowise-upload-hook -- --framework-dir <checkout> [--state-dir <directory>] [--environment staging|production]",
    );
  }
  return parsed;
}

function stateDirFor(parsed: { stateDir?: string }): string {
  return resolveProspectivePath(
    parsed.stateDir ??
      path.join(os.homedir(), ".local", "state", "tpf-author-mcp", "repowise"),
  );
}

function requireExternalStateDirectory(
  frameworkDir: string,
  stateDir: string,
): void {
  if (
    containsPath(frameworkDir, stateDir) ||
    containsPath(stateDir, frameworkDir)
  ) {
    throw new Error(
      `--state-dir and --framework-dir must be unrelated paths; received ${stateDir}`,
    );
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function resolveProspectivePath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
