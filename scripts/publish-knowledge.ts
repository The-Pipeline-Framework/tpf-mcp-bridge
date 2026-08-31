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
  verifyFrameworkSnapshot,
  writeBundle,
} from "../src/publication.js";
import {
  exportHealthyRepowiseInput,
  parseStoredRepowiseInputManifest,
  readRepowiseInput,
} from "../src/repowise-input.js";

const execute = promisify(execFile);
const wranglerExecutable = path.resolve("node_modules/.bin/wrangler");
const R2_UPLOAD_CONCURRENCY = 16;
const WRANGLER_TIMEOUT_MILLISECONDS = 120_000;
const WRANGLER_RETRY_ATTEMPTS = 4;
const args = parseArgs(process.argv.slice(2));
const publicationKind = args.snapshot ? "SNAPSHOT" : "RELEASE";
const release = args.snapshot
  ? verifyFrameworkSnapshot(args.frameworkDir, args.version)
  : verifyFrameworkRelease(args.frameworkDir, args.version);
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
    kind: publicationKind,
  });
  writeBundle(bundle, args.outputDir);
  console.log(
    `Compiled ${bundle.manifest.documentCount} pages and ${bundle.manifest.sourceCount} source files.`,
  );
  console.log(`Bundle checksum: ${bundle.manifest.bundleChecksum}`);
  if (args.stageOnly || args.publish) {
    await publish(
      args,
      bundle.manifest.bundleChecksum,
      bundle.manifest.datasetVersion,
      args.publish,
    );
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
    repowiseIndexDir: "",
    snapshot: false,
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
    else if (value === "--snapshot") parsed.snapshot = true;
    else if (value === "--repowise-index-dir")
      parsed.repowiseIndexDir = path.resolve(
        requireValue(values, ++index, value),
      );
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
      "Usage: npm run publish:knowledge -- --framework-dir <checkout> --version <x.y.z> [--snapshot --repowise-index-dir <indexed-checkout>] [--repowise-r2-commit <sha> [--wait-for-repowise-seconds <0..1800>]|--repowise-export <json> --repowise-version <version> --repowise-export-checksum <sha256>] [--output <dir>] [--environment staging|production] [--stage-only|--publish]",
    );
  }
  const expectedVersion = parsed.snapshot
    ? /^\d+\.\d+\.\d+-SNAPSHOT$/
    : /^\d+\.\d+\.\d+$/;
  if (!expectedVersion.test(parsed.version))
    throw new Error(
      parsed.snapshot
        ? "snapshot version must be exact x.y.z-SNAPSHOT"
        : "version must be an exact x.y.z release",
    );
  if (parsed.publish && parsed.stageOnly)
    throw new Error("--publish and --stage-only are mutually exclusive");
  if (parsed.snapshot && parsed.stageOnly)
    throw new Error("Snapshots use atomic --publish and cannot be staged");
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
    parsed.repowiseIndexDir !== "" &&
    (parsed.repowiseR2Commit !== "" || parsed.repowiseExportFile !== "")
  )
    throw new Error(
      "--repowise-index-dir cannot be combined with stored Repowise input",
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
    await wrangler(
      [
        "r2",
        "object",
        "get",
        `${bucket}/${prefix}/wiki_pages.json`,
        "--remote",
        "--file",
        exportFile,
        ...environmentArgs,
      ],
      false,
      true,
    );
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
    args.repowiseIndexDir || args.frameworkDir,
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
          `Exact Repowise input for framework commit ${frameworkCommit} is unavailable. A maintainer can upload the queued immutable input and rerun this MCP workflow. ${details}`,
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
  datasetVersion: string,
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
    args.snapshot
      ? `SELECT r.bundle_checksum, r.status, r.publication_kind FROM knowledge_aliases AS a JOIN releases AS r ON r.version = a.dataset_version WHERE a.public_version = ${sqlLiteral(args.version)}`
      : `SELECT bundle_checksum, status, publication_kind FROM releases WHERE version = ${sqlLiteral(args.version)}`,
    ...environmentArgs,
  ]);
  const checksums = collectValues(existing, new Set(["bundle_checksum"]));
  const kinds = collectValues(existing, new Set(["publication_kind"]));
  if (kinds.some((kind) => kind !== publicationKind)) {
    throw new Error(
      `Knowledge version ${args.version} already exists with a different publication kind`,
    );
  }
  if (args.snapshot) {
    const statuses = collectValues(existing, new Set(["status"]));
    if (
      checksums.length > 0 &&
      checksums.every((existingChecksum) => existingChecksum === checksum) &&
      statuses.includes("ACTIVE")
    ) {
      console.log(
        `Snapshot ${args.version} already points to the same checksum; publication is a no-op.`,
      );
      return;
    }
    await uploadBundle(args, bucket);
    await stageBundle(database, environmentArgs, args.outputDir);
    await verifyPublication(
      database,
      environmentArgs,
      datasetVersion,
      "STAGED",
    );
    await activateBundle(database, environmentArgs, args.outputDir);
    await verifyPublication(database, environmentArgs, args.version, "ACTIVE");
    console.log(
      `Published atomic TPF snapshot ${args.version} in ${args.environment}.`,
    );
    return;
  }
  if (validateImmutableRelease(checksums, checksum) === "EXISTS") {
    const statuses = collectValues(existing, new Set(["status"]));
    if (!activate || statuses.includes("ACTIVE")) {
      console.log(
        `Release ${args.version} already exists with the same checksum; ${activate ? "publication" : "staging"} is a no-op.`,
      );
      return;
    }
  } else {
    await uploadBundle(args, bucket);
    await stageBundle(database, environmentArgs, args.outputDir);
  }
  await verifyPublication(database, environmentArgs, args.version, "STAGED");
  if (!activate) {
    console.log(
      `Staged immutable TPF ${args.version} candidate in ${args.environment}.`,
    );
    return;
  }
  await activateBundle(database, environmentArgs, args.outputDir);
  await applySupportWindow(database, environmentArgs);
  console.log(
    `Published and activated TPF ${args.version} in ${args.environment}.`,
  );
}

async function stageBundle(
  database: string,
  environmentArgs: string[],
  outputDir: string,
): Promise<void> {
  const chunks = JSON.parse(
    readFileSync(path.join(outputDir, "stage-chunks.json"), "utf8"),
  ) as string[];
  for (const chunk of chunks) {
    await wrangler(
      [
        "d1",
        "execute",
        database,
        "--remote",
        "--yes",
        "--file",
        path.join(outputDir, chunk),
        ...environmentArgs,
      ],
      false,
      true,
    );
  }
}

async function activateBundle(
  database: string,
  environmentArgs: string[],
  outputDir: string,
): Promise<void> {
  await wrangler(
    [
      "d1",
      "execute",
      database,
      "--remote",
      "--yes",
      "--file",
      path.join(outputDir, "activate.sql"),
      ...environmentArgs,
    ],
    true,
    true,
  );
}

async function uploadBundle(
  args: ReturnType<typeof parseArgs>,
  bucket: string,
): Promise<void> {
  const environmentArgs =
    args.environment === "staging" ? ["--env", "staging"] : [];
  const uploads = JSON.parse(
    readFileSync(path.join(args.outputDir, "uploads.json"), "utf8"),
  ) as Array<{ key: string; file: string; contentType: string }>;
  await mapConcurrent(
    uploads,
    R2_UPLOAD_CONCURRENCY,
    ({ key, file, contentType }) =>
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
          ...environmentArgs,
        ],
        false,
        true,
      ),
  );
}

async function verifyPublication(
  database: string,
  environmentArgs: string[],
  version: string,
  expectedStatus: "STAGED" | "ACTIVE",
): Promise<void> {
  const verification = await wranglerJson([
    "d1",
    "execute",
    database,
    "--remote",
    "--command",
    expectedStatus === "ACTIVE" && version.endsWith("-SNAPSHOT")
      ? `SELECT r.document_count, r.source_count, r.status FROM knowledge_aliases AS a JOIN releases AS r ON r.version = a.dataset_version WHERE a.public_version = ${sqlLiteral(version)}`
      : `SELECT document_count, source_count, status FROM releases WHERE version = ${sqlLiteral(version)}`,
    ...environmentArgs,
  ]);
  const verificationStatuses = collectValues(verification, new Set(["status"]));
  if (
    verificationStatuses.length !== 1 ||
    verificationStatuses[0] !== expectedStatus
  )
    throw new Error(`${expectedStatus} knowledge verification failed`);
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
    "SELECT version FROM releases WHERE status = 'ACTIVE' AND publication_kind = 'RELEASE'",
    ...environmentArgs,
  ]);
  const versions = collectValues(rows, new Set(["version"]));
  const supported = supportedMinorLines(versions);
  const statements = versions
    .map((version) => {
      const [major, minor] = version.split(".");
      return `UPDATE releases SET supported = ${supported.has(`${major}.${minor}`) ? 1 : 0} WHERE version = ${sqlLiteral(version)} AND publication_kind = 'RELEASE';`;
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

async function wrangler(
  values: string[],
  inherit = true,
  retryTransientFailure = false,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await execute(wranglerExecutable, values, {
        maxBuffer: 64 * 1024 * 1024,
        timeout: WRANGLER_TIMEOUT_MILLISECONDS,
      });
      if (inherit && result.stdout) process.stdout.write(result.stdout);
      return result.stdout;
    } catch (error) {
      if (
        !retryTransientFailure ||
        attempt >= WRANGLER_RETRY_ATTEMPTS ||
        !isTransientWranglerFailure(error)
      )
        throw error;
      await delay(1_000 * 2 ** (attempt - 1));
    }
  }
}

async function wranglerJson(values: string[]): Promise<unknown> {
  return JSON.parse(await wrangler([...values, "--json"], false, true));
}

function isTransientWranglerFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = [
    error.message,
    "stdout" in error ? String(error.stdout) : "",
    "stderr" in error ? String(error.stderr) : "",
  ].join("\n");
  return /EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network connectivity|socket hang up|timed out|Unable to resolve Cloudflare's API hostname/i.test(
    details,
  );
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
