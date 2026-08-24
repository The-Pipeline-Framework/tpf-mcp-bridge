import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  parseStoredRepowiseInputManifest,
  readRepowiseInput,
  validateImmutableRepowiseInput,
  type RepowiseInput,
  type StoredRepowiseInputManifest,
} from "./repowise-input.js";

export interface QueuedRepowiseInput {
  directory: string;
  exportFile: string;
  manifest: StoredRepowiseInputManifest;
}

export function repowiseQueueDirectory(frameworkDir: string): string {
  return path.join(frameworkDir, ".repowise", "tpf-mcp-upload-queue");
}

export function stageRepowiseInput(
  queueDirectory: string,
  manifest: StoredRepowiseInputManifest,
  input: RepowiseInput,
): QueuedRepowiseInput {
  mkdirSync(queueDirectory, { recursive: true });
  const destination = path.join(queueDirectory, manifest.frameworkCommit);
  if (existsSync(destination)) {
    return validateQueuedInput(destination, manifest.frameworkCommit, input);
  }

  const temporary = mkdtempSync(path.join(queueDirectory, ".staging-"));
  try {
    writeFileSync(path.join(temporary, "wiki_pages.json"), input.bytes);
    writeFileSync(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    );
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
      return validateQueuedInput(destination, manifest.frameworkCommit, input);
    }
    return validateQueuedInput(destination, manifest.frameworkCommit, input);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function listQueuedRepowiseInputs(
  queueDirectory: string,
): QueuedRepowiseInput[] {
  if (!existsSync(queueDirectory)) return [];
  return readdirSync(queueDirectory, { withFileTypes: true })
    .map((entry) => {
      const commit = entry.name;
      if (!entry.isDirectory()) return undefined;
      if (!/^[a-f0-9]{40}$/.test(commit)) return undefined;
      const directory = path.join(queueDirectory, commit);
      return readQueuedInput(directory, commit);
    })
    .filter((entry): entry is QueuedRepowiseInput => entry !== undefined)
    .sort(
      (left, right) =>
        left.manifest.sourceCommittedAt.localeCompare(
          right.manifest.sourceCommittedAt,
        ) ||
        left.manifest.frameworkCommit.localeCompare(
          right.manifest.frameworkCommit,
        ),
    );
}

export function removeQueuedRepowiseInput(input: QueuedRepowiseInput): void {
  rmSync(input.directory, { recursive: true, force: true });
}

export function acquireRepowiseQueueLock(
  queueDirectory: string,
): (() => void) | undefined {
  mkdirSync(queueDirectory, { recursive: true });
  const lockFile = path.join(queueDirectory, ".upload.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockFile, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${process.pid}\n`);
      } finally {
        closeSync(descriptor);
      }
      return () => {
        try {
          unlinkSync(lockFile);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      };
    } catch (error) {
      if (!isExists(error)) throw error;
      if (!removeStaleLock(lockFile)) return undefined;
    }
  }
  return undefined;
}

function validateQueuedInput(
  directory: string,
  expectedCommit: string,
  requested: RepowiseInput,
): QueuedRepowiseInput {
  const queued = readQueuedInput(directory, expectedCommit);
  validateImmutableRepowiseInput(
    queued.manifest.exportChecksum,
    requested.checksum,
  );
  if (queued.manifest.repowiseVersion !== requested.version) {
    throw new Error(
      `Queued Repowise input for ${expectedCommit} has a different Repowise version`,
    );
  }
  return queued;
}

function readQueuedInput(
  directory: string,
  expectedCommit: string,
): QueuedRepowiseInput {
  const exportFile = path.join(directory, "wiki_pages.json");
  const manifest = parseStoredRepowiseInputManifest(
    JSON.parse(
      readFileSync(path.join(directory, "manifest.json"), "utf8"),
    ) as unknown,
    expectedCommit,
  );
  readRepowiseInput(
    exportFile,
    manifest.repowiseVersion,
    manifest.exportChecksum,
  );
  return { directory, exportFile, manifest };
}

function removeStaleLock(lockFile: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (!isNoSuchProcess(error)) return false;
    }
  }
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return true;
}

function isExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isNoSuchProcess(error: unknown): boolean {
  return hasCode(error, "ESRCH");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
