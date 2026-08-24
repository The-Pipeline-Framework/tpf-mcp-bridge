import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface RepowiseInput {
  version: string;
  bytes: Buffer;
  checksum: string;
}

export interface StoredRepowiseInputManifest {
  schemaVersion: 1;
  frameworkCommit: string;
  repowiseVersion: string;
  exportChecksum: string;
  sourceCommittedAt: string;
}

export function parseStoredRepowiseInputManifest(
  value: unknown,
  expectedCommit: string,
): StoredRepowiseInputManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Stored Repowise input manifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.frameworkCommit !== expectedCommit) {
    throw new Error(
      `Stored Repowise input manifest does not match framework commit ${expectedCommit}`,
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.repowiseVersion !== "string" ||
    typeof manifest.exportChecksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.exportChecksum) ||
    typeof manifest.sourceCommittedAt !== "string"
  ) {
    throw new Error(
      "Stored Repowise input manifest has invalid provenance fields",
    );
  }
  return manifest as unknown as StoredRepowiseInputManifest;
}

export function validateImmutableRepowiseInput(
  existingChecksum: string | undefined,
  requestedChecksum: string,
): "UPLOAD" | "NOOP" {
  if (existingChecksum === undefined) return "UPLOAD";
  if (existingChecksum === requestedChecksum) return "NOOP";
  throw new Error(
    "Repowise input is immutable and already has a different checksum",
  );
}

export function exportHealthyRepowiseInput(
  frameworkDir: string,
  expectedCommit: string,
  outputDir: string,
): RepowiseInput {
  verifyRepowiseHealth(frameworkDir, expectedCommit);
  execFileSync(
    "repowise",
    [
      "export",
      "--format",
      "json",
      "--full",
      "--output",
      outputDir,
      frameworkDir,
    ],
    { stdio: "inherit" },
  );
  const bytes = readFileSync(path.join(outputDir, "wiki_pages.json"));
  return {
    version: execFileSync("repowise", ["--version"], { encoding: "utf8" })
      .trim()
      .replace(/^repowise, version\s+/, ""),
    bytes,
    checksum: sha256(bytes),
  };
}

export function readRepowiseInput(
  file: string,
  version: string,
  expectedChecksum: string,
): RepowiseInput {
  const bytes = readFileSync(file);
  const checksum = sha256(bytes);
  if (checksum !== expectedChecksum) {
    throw new Error(
      `Stored Repowise export checksum ${checksum} does not match declared ${expectedChecksum}`,
    );
  }
  return { version, bytes, checksum };
}

export function verifyRepowiseHealth(
  frameworkDir: string,
  expectedCommit: string,
): void {
  const raw = execFileSync(
    "repowise",
    ["doctor", "--format", "json", "--no-workspace", frameworkDir],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const state = JSON.parse(
    readFileSync(path.join(frameworkDir, ".repowise", "state.json"), "utf8"),
  ) as unknown;
  const report = raw.trim().length === 0 ? state : (JSON.parse(raw) as unknown);
  validateRepowiseHealthReport(report, state, expectedCommit);
}

export function validateRepowiseHealthReport(
  report: unknown,
  state: unknown,
  expectedCommit: string,
): void {
  const commits = collectValues(
    [report, state],
    new Set([
      "indexed_commit",
      "indexedCommit",
      "last_sync_commit",
      "last_docs_commit",
    ]),
  );
  const shortCommit = expectedCommit.slice(0, 12);
  if (
    commits.length === 0 ||
    !commits.every(
      (commit) => commit === expectedCommit || commit === shortCommit,
    )
  ) {
    throw new Error(
      `Repowise index commit does not match framework commit ${expectedCommit}`,
    );
  }
  const staleCounts = collectNumericValues(
    report,
    new Set(["stale", "stale_pages", "stalePages"]),
  );
  if (staleCounts.some((count) => count > 0)) {
    throw new Error(
      `Repowise index contains stale pages: ${Math.max(...staleCounts)}`,
    );
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function collectNumericValues(value: unknown, keys: Set<string>): number[] {
  if (Array.isArray(value))
    return value.flatMap((entry) => collectNumericValues(entry, keys));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(keys.has(key) && typeof entry === "number" ? [entry] : []),
    ...collectNumericValues(entry, keys),
  ]);
}
