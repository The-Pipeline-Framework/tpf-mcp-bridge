import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const bridgeDir = path.resolve(".");
const hookPath = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-path", "hooks/post-commit"],
  { cwd: args.frameworkDir, encoding: "utf8" },
).trim();
const hook = readFileSync(hookPath, "utf8");
if (
  !hook.includes("# repowise-hook-start") ||
  !hook.includes("# repowise-hook-end")
) {
  throw new Error(
    "Repowise post-commit hook is not installed; run 'repowise hook install' first",
  );
}
const start = "    # tpf-mcp-upload-start";
const end = "    # tpf-mcp-upload-end";
const withoutExisting = hook.replace(
  new RegExp(`${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`, "g"),
  "",
);
const insertion = [
  start,
  `    if [ "$ROOT" = ${shellQuote(args.frameworkDir)} ]; then`,
  `      (cd ${shellQuote(bridgeDir)} && npm run upload:repowise-input -- --framework-dir ${shellQuote(args.frameworkDir)} --environment ${args.environment} --attempts 4) >> "$LOG" 2>&1 || true`,
  "    fi",
  end,
  "",
].join("\n");
const close = "  ) &\n} >/dev/null 2>&1";
if (!withoutExisting.includes(close)) {
  throw new Error("Repowise post-commit hook shape is unsupported");
}
writeFileSync(
  hookPath,
  withoutExisting.replace(close, `${insertion}${close}`),
  {
    mode: 0o755,
  },
);
installPostMergeHook();
installPostCheckoutRetry();
console.log(
  `Installed durable Repowise export/upload hooks for commits, merges, and queued retries (${args.environment}).`,
);

function installPostMergeHook(): void {
  const command = [
    "ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    `[ "$ROOT" = ${shellQuote(args.frameworkDir)} ] || exit 0`,
    `LOG="$ROOT/.repowise/.update.log"`,
    "(",
    `  cd ${shellQuote(args.frameworkDir)} || exit 1`,
    "  if command -v repowise >/dev/null 2>&1; then",
    '    repowise update --workspace --repo pipelineframework >> "$LOG" 2>&1',
    "  elif command -v uv >/dev/null 2>&1; then",
    '    uv run repowise update --workspace --repo pipelineframework >> "$LOG" 2>&1',
    "  else",
    '    printf "repowise executable not found; merge knowledge update deferred\\n" >> "$LOG"',
    "    exit 1",
    "  fi",
    `  (cd ${shellQuote(bridgeDir)} && npm run upload:repowise-input -- --framework-dir ${shellQuote(args.frameworkDir)} --environment ${args.environment} --attempts 4) >> "$LOG" 2>&1`,
    ") >/dev/null 2>&1 &",
  ].join("\n");
  installManagedHook("post-merge", "tpf-mcp-post-merge", command);
}

function installPostCheckoutRetry(): void {
  const command = [
    "ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
    `[ "$ROOT" = ${shellQuote(args.frameworkDir)} ] || exit 0`,
    `LOG="$ROOT/.repowise/.update.log"`,
    `if [ -d "$ROOT/.repowise/tpf-mcp-upload-queue" ]; then`,
    `  (cd ${shellQuote(bridgeDir)} && npm run upload:repowise-input -- --framework-dir ${shellQuote(args.frameworkDir)} --environment ${args.environment} --retry-only --attempts 2) >> "$LOG" 2>&1 &`,
    "fi",
  ].join("\n");
  installManagedHook("post-checkout", "tpf-mcp-post-checkout", command);
}

function installManagedHook(
  name: string,
  marker: string,
  command: string,
): void {
  const target = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`],
    { cwd: args.frameworkDir, encoding: "utf8" },
  ).trim();
  const begin = `# ${marker}-start`;
  const finish = `# ${marker}-end`;
  const existing = existsSync(target)
    ? readFileSync(target, "utf8")
    : "#!/bin/sh\n";
  const withoutExisting = existing.replace(
    new RegExp(
      `${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(finish)}\\n?`,
      "g",
    ),
    "",
  );
  writeFileSync(
    target,
    `${withoutExisting.trimEnd()}\n${begin}\n${command}\n${finish}\n`,
    { mode: 0o755 },
  );
}

function parseArgs(values: string[]) {
  const parsed = {
    frameworkDir: "",
    environment: "production" as "staging" | "production",
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--framework-dir")
      parsed.frameworkDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--environment") {
      const environment = requireValue(values, ++index, value);
      if (environment !== "staging" && environment !== "production")
        throw new Error("environment must be staging or production");
      parsed.environment = environment;
    } else throw new Error(`Unknown argument '${value}'`);
  }
  if (parsed.frameworkDir === "") {
    throw new Error(
      "Usage: npm run install:repowise-upload-hook -- --framework-dir <checkout> [--environment staging|production]",
    );
  }
  return parsed;
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
