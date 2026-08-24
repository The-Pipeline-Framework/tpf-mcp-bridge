import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  exportHealthyRepowiseInput,
  parseStoredRepowiseInputManifest,
  validateImmutableRepowiseInput,
  type StoredRepowiseInputManifest,
} from "../src/repowise-input.js";
import {
  acquireRepowiseQueueLock,
  listQueuedRepowiseInputs,
  removeQueuedRepowiseInput,
  repowiseQueueDirectory,
  stageRepowiseInput,
  type QueuedRepowiseInput,
} from "../src/repowise-queue.js";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const queueDirectory = repowiseQueueDirectory(args.frameworkDir);
const releaseLock = acquireRepowiseQueueLock(queueDirectory);
if (releaseLock === undefined) {
  console.log("Another Repowise input export/upload process is active.");
  process.exit(0);
}

try {
  if (!args.retryOnly) stageCurrentInput();
  await deliverQueue();
} finally {
  releaseLock();
}

function stageCurrentInput(): void {
  const status = git(args.frameworkDir, ["status", "--porcelain"]);
  if (status.trim().length > 0)
    throw new Error(
      "Framework checkout must be clean before exporting Repowise input",
    );
  const frameworkCommit = git(args.frameworkDir, ["rev-parse", "HEAD"]).trim();
  const sourceCommittedAt = git(args.frameworkDir, [
    "show",
    "-s",
    "--format=%cI",
    "HEAD",
  ]).trim();
  const temporary = mkdtempSync(path.join(os.tmpdir(), "tpf-repowise-input-"));
  try {
    const input = exportHealthyRepowiseInput(
      args.frameworkDir,
      frameworkCommit,
      path.join(temporary, "export"),
    );
    const manifest: StoredRepowiseInputManifest = {
      schemaVersion: 1,
      frameworkCommit,
      repowiseVersion: input.version,
      exportChecksum: input.checksum,
      sourceCommittedAt,
    };
    stageRepowiseInput(queueDirectory, manifest, input);
    console.log(`Queued immutable Repowise input for ${frameworkCommit}.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function deliverQueue(): Promise<void> {
  let remaining = listQueuedRepowiseInputs(queueDirectory);
  if (remaining.length === 0) {
    console.log("No Repowise inputs are waiting for upload.");
    return;
  }
  let failures = new Map<string, string>();
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    failures = new Map();
    const next: QueuedRepowiseInput[] = [];
    for (const input of remaining) {
      try {
        await upload(input);
        removeQueuedRepowiseInput(input);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        failures.set(input.manifest.frameworkCommit, details);
        next.push(input);
      }
    }
    remaining = next;
    if (remaining.length === 0) return;
    if (attempt < args.attempts) {
      const delaySeconds = Math.min(30, 5 * 2 ** (attempt - 1));
      console.warn(
        `Repowise upload attempt ${attempt} failed for ${remaining.length} input(s); retrying in ${delaySeconds}s.`,
      );
      await delay(delaySeconds * 1000);
    }
  }
  throw new Error(
    `Repowise input upload remains queued: ${Array.from(failures, ([commit, details]) => `${commit}: ${details}`).join("; ")}`,
  );
}

async function upload(input: QueuedRepowiseInput): Promise<void> {
  const environmentArgs =
    args.environment === "staging" ? ["--env", "staging"] : [];
  const bucket =
    args.environment === "staging"
      ? "tpf-mcp-knowledge-staging"
      : "tpf-mcp-knowledge";
  const commit = input.manifest.frameworkCommit;
  const prefix = `inputs/repowise/${commit}`;
  const existing = await readExistingManifest(
    bucket,
    prefix,
    environmentArgs,
    commit,
  );
  if (existing !== undefined) {
    validateImmutableRepowiseInput(
      existing.exportChecksum,
      input.manifest.exportChecksum,
    );
    console.log(`Repowise input for ${commit} is already uploaded.`);
    return;
  }
  await wrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${prefix}/wiki_pages.json`,
    "--remote",
    "--file",
    input.exportFile,
    "--content-type",
    "application/json",
    ...environmentArgs,
  ]);
  await wrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${prefix}/manifest.json`,
    "--remote",
    "--file",
    path.join(input.directory, "manifest.json"),
    "--content-type",
    "application/json",
    ...environmentArgs,
  ]);
  console.log(
    `Uploaded immutable Repowise input for ${commit} to ${args.environment}.`,
  );
}

function parseArgs(values: string[]) {
  const parsed = {
    frameworkDir: "",
    environment: "production" as "staging" | "production",
    retryOnly: false,
    attempts: 1,
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
    } else if (value === "--retry-only") parsed.retryOnly = true;
    else if (value === "--attempts") {
      parsed.attempts = Number.parseInt(
        requireValue(values, ++index, value),
        10,
      );
      if (!Number.isInteger(parsed.attempts) || parsed.attempts < 1)
        throw new Error("attempts must be a positive integer");
    } else throw new Error(`Unknown argument '${value}'`);
  }
  if (parsed.frameworkDir === "")
    throw new Error(
      "Usage: npm run upload:repowise-input -- --framework-dir <checkout> [--environment staging|production] [--retry-only] [--attempts <n>]",
    );
  return parsed;
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return value;
}

async function readExistingManifest(
  bucket: string,
  prefix: string,
  environmentArgs: string[],
  frameworkCommit: string,
): Promise<StoredRepowiseInputManifest | undefined> {
  try {
    const raw = await wrangler(
      [
        "r2",
        "object",
        "get",
        `${bucket}/${prefix}/manifest.json`,
        "--remote",
        "--pipe",
        ...environmentArgs,
      ],
      false,
    );
    return parseStoredRepowiseInputManifest(
      JSON.parse(raw) as unknown,
      frameworkCommit,
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    if (/not found|404|does not exist/i.test(details)) return undefined;
    throw error;
  }
}

function git(directory: string, values: string[]): string {
  return execFileSync("git", values, { cwd: directory, encoding: "utf8" });
}

async function wrangler(values: string[], inherit = true): Promise<string> {
  const result = await execute("npx", ["wrangler", ...values], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (inherit && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
