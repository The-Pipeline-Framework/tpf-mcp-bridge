import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  compileBundle,
  sqlLiteral,
  supportedMinorLines,
  validateImmutableRelease,
  verifyFrameworkRelease,
  writeBundle,
} from "../src/publication.js";
import {
  exportHealthyRepowiseInput,
  parseStoredRepowiseInputManifest,
  readRepowiseInput,
} from "../src/repowise-input.js";

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const release = verifyFrameworkRelease(args.frameworkDir, args.version);
const temporary = mkdtempSync(path.join(os.tmpdir(), "tpf-knowledge-"));

try {
  const input = await resolveRepowiseInput(args, release.commit, temporary);
  const bundle = compileBundle({
    frameworkDir: args.frameworkDir,
    version: args.version,
    frameworkCommit: release.commit,
    publishedAt: release.publishedAt,
    repowiseVersion: input.version,
    repowiseExportBytes: input.bytes,
  });
  writeBundle(bundle, args.outputDir);
  console.log(
    `Compiled ${bundle.manifest.documentCount} pages and ${bundle.manifest.sourceCount} source files.`,
  );
  console.log(`Bundle checksum: ${bundle.manifest.bundleChecksum}`);
  if (args.stageOnly || args.publish) {
    await publish(args, bundle.manifest.bundleChecksum, args.publish);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function parseArgs(values: string[]) {
  const parsed = {
    frameworkDir: "",
    version: "",
    outputDir: "",
    environment: "staging" as "staging" | "production",
    publish: false,
    stageOnly: false,
    repowiseExportFile: "",
    repowiseVersion: "",
    repowiseExportChecksum: "",
    repowiseR2Commit: "",
    waitForRepowiseSeconds: 0,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--framework-dir")
      parsed.frameworkDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--version")
      parsed.version = requireValue(values, ++index, value);
    else if (value === "--output")
      parsed.outputDir = path.resolve(requireValue(values, ++index, value));
    else if (value === "--environment") {
      const environment = requireValue(values, ++index, value);
      if (environment !== "staging" && environment !== "production")
        throw new Error("environment must be staging or production");
      parsed.environment = environment;
    } else if (value === "--publish") parsed.publish = true;
    else if (value === "--stage-only") parsed.stageOnly = true;
    else if (value === "--repowise-export")
      parsed.repowiseExportFile = path.resolve(
        requireValue(values, ++index, value),
      );
    else if (value === "--repowise-version")
      parsed.repowiseVersion = requireValue(values, ++index, value);
    else if (value === "--repowise-export-checksum")
      parsed.repowiseExportChecksum = requireValue(values, ++index, value);
    else if (value === "--repowise-r2-commit")
      parsed.repowiseR2Commit = requireValue(values, ++index, value);
    else if (value === "--wait-for-repowise-seconds") {
      parsed.waitForRepowiseSeconds = Number.parseInt(
        requireValue(values, ++index, value),
        10,
      );
      if (
        !Number.isInteger(parsed.waitForRepowiseSeconds) ||
        parsed.waitForRepowiseSeconds < 0 ||
        parsed.waitForRepowiseSeconds > 1800
      )
        throw new Error("wait-for-repowise-seconds must be between 0 and 1800");
    } else throw new Error(`Unknown argument '${value}'`);
  }
  if (!parsed.frameworkDir || !parsed.version) {
    throw new Error(
      "Usage: npm run publish:knowledge -- --framework-dir <checkout> --version <x.y.z> [--repowise-r2-commit <sha> [--wait-for-repowise-seconds <0..1800>]|--repowise-export <json> --repowise-version <version> --repowise-export-checksum <sha256>] [--output <dir>] [--environment staging|production] [--stage-only|--publish]",
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(parsed.version))
    throw new Error("version must be an exact x.y.z release");
  if (parsed.publish && parsed.stageOnly)
    throw new Error("--publish and --stage-only are mutually exclusive");
  if (
    parsed.repowiseExportFile !== "" &&
    (parsed.repowiseVersion === "" || parsed.repowiseExportChecksum === "")
  )
    throw new Error(
      "Stored Repowise input requires --repowise-version and --repowise-export-checksum",
    );
  if (parsed.repowiseR2Commit !== "" && parsed.repowiseExportFile !== "")
    throw new Error(
      "--repowise-r2-commit and --repowise-export are mutually exclusive",
    );
  if (
    parsed.repowiseR2Commit !== "" &&
    !/^[a-f0-9]{40}$/.test(parsed.repowiseR2Commit)
  )
    throw new Error("--repowise-r2-commit must be a full lowercase Git SHA");
  if (!parsed.outputDir)
    parsed.outputDir = path.resolve(".publication", parsed.version);
  return parsed;
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return value;
}

async function resolveRepowiseInput(
  args: ReturnType<typeof parseArgs>,
  frameworkCommit: string,
  temporary: string,
) {
  if (args.repowiseR2Commit !== "") {
    if (args.repowiseR2Commit !== frameworkCommit) {
      throw new Error(
        `Requested Repowise input ${args.repowiseR2Commit} does not match release commit ${frameworkCommit}`,
      );
    }
    const environmentArgs =
      args.environment === "staging" ? ["--env", "staging"] : [];
    const bucket =
      args.environment === "staging"
        ? "tpf-mcp-knowledge-staging"
        : "tpf-mcp-knowledge";
    const prefix = `inputs/repowise/${frameworkCommit}`;
    const manifest = parseStoredRepowiseInputManifest(
      JSON.parse(
        await waitForRepowiseManifest(
          bucket,
          prefix,
          environmentArgs,
          frameworkCommit,
          args.waitForRepowiseSeconds,
        ),
      ),
      frameworkCommit,
    );
    const exportFile = path.join(temporary, "stored-repowise-export.json");
    await wrangler([
      "r2",
      "object",
      "get",
      `${bucket}/${prefix}/wiki_pages.json`,
      "--remote",
      "--file",
      exportFile,
      ...environmentArgs,
    ]);
    return readRepowiseInput(
      exportFile,
      manifest.repowiseVersion,
      manifest.exportChecksum,
    );
  }
  if (args.repowiseExportFile !== "") {
    return readRepowiseInput(
      args.repowiseExportFile,
      args.repowiseVersion,
      args.repowiseExportChecksum,
    );
  }
  return exportHealthyRepowiseInput(
    args.frameworkDir,
    frameworkCommit,
    path.join(temporary, "repowise"),
  );
}

async function waitForRepowiseManifest(
  bucket: string,
  prefix: string,
  environmentArgs: string[],
  frameworkCommit: string,
  waitSeconds: number,
): Promise<string> {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    try {
      return await wrangler(
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
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      if (
        !/not found|404|does not exist/i.test(details) ||
        Date.now() >= deadline
      )
        throw new Error(
          `Exact Repowise input for release commit ${frameworkCommit} is unavailable. A maintainer can upload the queued immutable input and rerun this MCP workflow. ${details}`,
          { cause: error },
        );
      console.log(
        `Waiting for exact Repowise input ${frameworkCommit} (${Math.ceil((deadline - Date.now()) / 1000)}s remaining).`,
      );
      await delay(Math.min(30_000, Math.max(1, deadline - Date.now())));
    }
  }
}

async function publish(
  args: ReturnType<typeof parseArgs>,
  checksum: string,
  activate: boolean,
): Promise<void> {
  const environmentArgs =
    args.environment === "staging" ? ["--env", "staging"] : [];
  const database =
    args.environment === "staging"
      ? "tpf-mcp-knowledge-staging"
      : "tpf-mcp-knowledge";
  const bucket =
    args.environment === "staging"
      ? "tpf-mcp-knowledge-staging"
      : "tpf-mcp-knowledge";
  await wrangler([
    "d1",
    "migrations",
    "apply",
    database,
    "--remote",
    ...environmentArgs,
  ]);
  const existing = await wranglerJson([
    "d1",
    "execute",
    database,
    "--remote",
    "--command",
    `SELECT bundle_checksum, status FROM releases WHERE version = ${sqlLiteral(args.version)}`,
    ...environmentArgs,
  ]);
  const checksums = collectValues(existing, new Set(["bundle_checksum"]));
  if (validateImmutableRelease(checksums, checksum) === "EXISTS") {
    const statuses = collectValues(existing, new Set(["status"]));
    if (!activate || statuses.includes("ACTIVE")) {
      console.log(
        `Release ${args.version} already exists with the same checksum; ${activate ? "publication" : "staging"} is a no-op.`,
      );
      return;
    }
  } else {
    const uploads = JSON.parse(
      readFileSync(path.join(args.outputDir, "uploads.json"), "utf8"),
    ) as Array<{ key: string; file: string; contentType: string }>;
    await mapConcurrent(uploads, 8, ({ key, file, contentType }) =>
      wrangler(
        [
          "r2",
          "object",
          "put",
          `${bucket}/${key}`,
          "--remote",
          "--file",
          file,
          "--content-type",
          contentType,
        ],
        false,
      ),
    );
    await wrangler([
      "d1",
      "execute",
      database,
      "--remote",
      "--file",
      path.join(args.outputDir, "stage.sql"),
      ...environmentArgs,
    ]);
  }
  const verification = await wranglerJson([
    "d1",
    "execute",
    database,
    "--remote",
    "--command",
    `SELECT document_count, source_count, status FROM releases WHERE version = ${sqlLiteral(args.version)}`,
    ...environmentArgs,
  ]);
  const verificationStatuses = collectValues(verification, new Set(["status"]));
  if (verificationStatuses.length !== 1 || verificationStatuses[0] !== "STAGED")
    throw new Error("Staged release verification failed");
  if (!activate) {
    console.log(
      `Staged immutable TPF ${args.version} candidate in ${args.environment}.`,
    );
    return;
  }
  await wrangler([
    "d1",
    "execute",
    database,
    "--remote",
    "--file",
    path.join(args.outputDir, "activate.sql"),
    ...environmentArgs,
  ]);
  await applySupportWindow(database, environmentArgs);
  console.log(
    `Published and activated TPF ${args.version} in ${args.environment}.`,
  );
}

async function applySupportWindow(
  database: string,
  environmentArgs: string[],
): Promise<void> {
  const rows = await wranglerJson([
    "d1",
    "execute",
    database,
    "--remote",
    "--command",
    "SELECT version FROM releases WHERE status = 'ACTIVE'",
    ...environmentArgs,
  ]);
  const versions = collectValues(rows, new Set(["version"]));
  const supported = supportedMinorLines(versions);
  const statements = versions
    .map((version) => {
      const [major, minor] = version.split(".");
      return `UPDATE releases SET supported = ${supported.has(`${major}.${minor}`) ? 1 : 0} WHERE version = ${sqlLiteral(version)};`;
    })
    .join(" ");
  if (statements)
    await wrangler([
      "d1",
      "execute",
      database,
      "--remote",
      "--command",
      statements,
      ...environmentArgs,
    ]);
}

async function wrangler(values: string[], inherit = true): Promise<string> {
  const result = await execute("npx", ["wrangler", ...values], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (inherit && result.stdout) process.stdout.write(result.stdout);
  return result.stdout;
}

async function wranglerJson(values: string[]): Promise<unknown> {
  return JSON.parse(await wrangler([...values, "--json"], false));
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const value = values[cursor++];
        await operation(value);
      }
    }),
  );
}

function collectValues(value: unknown, keys: Set<string>): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry) => collectValues(entry, keys));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(keys.has(key) && typeof entry === "string" ? [entry] : []),
    ...collectValues(entry, keys),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
