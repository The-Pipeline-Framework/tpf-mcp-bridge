import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type RefreshEnvironment = "staging" | "production";

export interface RefreshConfiguration {
  schemaVersion: 1;
  bridgeDir: string;
  healthyDir: string;
  candidateDir: string;
  environment: RefreshEnvironment;
}

export interface RefreshRequest {
  schemaVersion: 1;
  commit: string;
  requestedAt: string;
}

export interface RefreshCompletion {
  schemaVersion: 1;
  commit: string;
  completedAt: string;
  durationSeconds: number;
  recovery: "incremental" | "empty-rebuild";
  modelPolicy: {
    prose: false;
    provider: "mock";
    model: "mock";
  };
}

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

const CONFIG_FILE = "refresh-config.json";
const REQUEST_FILE = "requested-refresh.json";
const COMPLETION_FILE = "completed-refresh.json";
const FAILURE_FILE = "failed-refresh.json";
const LOCK_FILE = "refresh.lock";
const PARTIAL_LOCK_GRACE_MS = 60 * 60 * 1000;
const LOCK_ACQUIRE_ATTEMPTS = 8;

export function writeRefreshConfiguration(
  stateDir: string,
  configuration: RefreshConfiguration,
): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path.join(stateDir, CONFIG_FILE), configuration);
}

export function readRefreshConfiguration(
  stateDir: string,
): RefreshConfiguration {
  const parsed = readJson(path.join(stateDir, CONFIG_FILE));
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.bridgeDir !== "string" ||
    typeof parsed.healthyDir !== "string" ||
    typeof parsed.candidateDir !== "string" ||
    (parsed.environment !== "staging" && parsed.environment !== "production")
  ) {
    throw new Error(`Invalid Repowise refresh configuration in ${stateDir}`);
  }
  return parsed as unknown as RefreshConfiguration;
}

export function requestRepowiseRefresh(
  stateDir: string,
  commit: string,
): RefreshRequest {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      `Refresh commit must be a full lowercase Git SHA: ${commit}`,
    );
  }
  const request: RefreshRequest = {
    schemaVersion: 1,
    commit,
    requestedAt: new Date().toISOString(),
  };
  const completed = readRefreshCompletion(stateDir);
  if (completed !== undefined) {
    if (completed.commit === commit) {
      if (readRequestedRefresh(stateDir)?.commit === commit) {
        rmSync(path.join(stateDir, REQUEST_FILE), { force: true });
      }
      return request;
    }
    const { healthyDir } = readRefreshConfiguration(stateDir);
    spawnSync("git", ["fetch", "origin", "main"], {
      cwd: healthyDir,
      stdio: "ignore",
      timeout: 60_000,
    });
    if (
      isKnownCommit(healthyDir, commit) &&
      isKnownCommit(healthyDir, completed.commit) &&
      isCommitAncestor(healthyDir, commit, completed.commit)
    ) {
      throw new Error(
        `Refusing to refresh older commit ${commit}; ${completed.commit} is already healthy`,
      );
    }
  }
  writeJsonAtomically(path.join(stateDir, REQUEST_FILE), request);
  return request;
}

export function readRequestedRefresh(
  stateDir: string,
): RefreshRequest | undefined {
  const file = path.join(stateDir, REQUEST_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = readJson(file);
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(parsed.commit) ||
    typeof parsed.requestedAt !== "string"
  ) {
    throw new Error(`Invalid queued Repowise refresh request in ${stateDir}`);
  }
  return parsed as unknown as RefreshRequest;
}

export function acquireRefreshLock(stateDir: string): (() => void) | undefined {
  const lock = path.join(stateDir, LOCK_FILE);
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const serializedOwner = `${JSON.stringify(owner)}\n`;
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(lock, serializedOwner, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readFileSync(lock, "utf8") === serializedOwner) {
            rmSync(lock, { force: true });
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (lockOwnerIsAlive(lock)) return undefined;
      const claimed = `${lock}.stale.${process.pid}.${owner.token}.${attempt}`;
      try {
        renameSync(lock, claimed);
        rmSync(claimed, { force: true });
      } catch (claimError) {
        if (!isNotFound(claimError)) throw claimError;
      }
    }
  }
  throw new Error(
    `Could not acquire Repowise refresh lock after ${LOCK_ACQUIRE_ATTEMPTS} attempts`,
  );
}

export function validateRepowiseHealth(
  report: unknown,
  indexedCommit: string,
  expectedCommit: string,
): void {
  if (!isDoctorReport(report)) {
    throw new Error("Repowise candidate is unhealthy: invalid doctor response");
  }
  const failedChecks = report.checks.filter((check) => !check.ok);
  if (!report.ok || failedChecks.length > 0) {
    const failures =
      failedChecks.length > 0
        ? failedChecks
            .map((check) => `${check.name}: ${check.detail}`)
            .join("; ")
        : "report ok flag disagrees with checks";
    throw new Error(`Repowise candidate is unhealthy: ${failures}`);
  }
  if (indexedCommit !== expectedCommit) {
    throw new Error(
      `Repowise candidate commit mismatch: expected ${expectedCommit}, found ${indexedCommit}`,
    );
  }
}

export function initializeRefreshCheckouts(
  sourceDir: string,
  stateDir: string,
): { healthyDir: string; candidateDir: string } {
  const healthyDir = path.join(stateDir, "framework");
  const candidateDir = path.join(stateDir, "candidate");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(path.join(healthyDir, ".git"))) {
    let cloneSource = sourceDir;
    let usedLocalSource = true;
    try {
      cloneSource = command(sourceDir, "git", [
        "remote",
        "get-url",
        "origin",
      ]).trim();
      usedLocalSource = false;
    } catch {
      // Local fixture repositories and offline installations can still seed
      // an independent clone from the supplied source checkout.
    }
    try {
      command(stateDir, "git", [
        "clone",
        "--no-local",
        cloneSource,
        healthyDir,
      ]);
    } catch (error) {
      if (cloneSource === sourceDir) throw error;
      rmSync(healthyDir, { recursive: true, force: true });
      command(stateDir, "git", ["clone", "--no-local", sourceDir, healthyDir]);
      usedLocalSource = true;
    }
    appendLog(
      stateDir,
      `initialized healthy clone from ${usedLocalSource ? "local source checkout" : "origin remote"}`,
    );
  }
  const commit = command(healthyDir, "git", ["rev-parse", "HEAD"]).trim();
  if (!existsSync(path.join(candidateDir, ".git"))) {
    rmSync(candidateDir, { recursive: true, force: true });
    command(healthyDir, "git", ["worktree", "prune"]);
    command(healthyDir, "git", [
      "worktree",
      "add",
      "--detach",
      candidateDir,
      commit,
    ]);
  }
  return { healthyDir, candidateDir };
}

export function runQueuedRefreshes(stateDir: string): void {
  while (true) {
    const release = acquireRefreshLock(stateDir);
    if (release === undefined) return;
    let drained = false;
    let blocked = false;
    try {
      const configuration = readRefreshConfiguration(stateDir);
      recoverInterruptedPromotion(configuration, stateDir);
      while (true) {
        const request = readRequestedRefresh(stateDir);
        if (request === undefined) {
          drained = true;
          break;
        }
        const previousFailure = readRefreshFailure(stateDir);
        if (previousFailure?.commit === request.commit) {
          appendLog(
            stateDir,
            `refresh ${request.commit} remains blocked after ${previousFailure.failedAt}: ${previousFailure.reason}`,
          );
          blocked = true;
          break;
        }
        rmSync(path.join(stateDir, FAILURE_FILE), { force: true });
        try {
          refreshCommit(configuration, stateDir, request.commit);
        } catch (error) {
          const failure = {
            schemaVersion: 1,
            commit: request.commit,
            failedAt: new Date().toISOString(),
            reason: errorMessage(error),
          };
          writeJsonAtomically(path.join(stateDir, FAILURE_FILE), failure);
          appendLog(
            stateDir,
            `refresh ${request.commit} failed and is blocked until a newer request or operator clearance: ${failure.reason}`,
          );
          blocked = true;
          break;
        }
        const latest = readRequestedRefresh(stateDir);
        if (latest?.commit === request.commit) {
          rmSync(path.join(stateDir, REQUEST_FILE), { force: true });
        }
      }
    } finally {
      release();
    }
    // Close the write-after-last-read race: a hook that queued while the lock
    // existed has already returned, so this runner must reacquire and drain it.
    if (!drained || blocked || readRequestedRefresh(stateDir) === undefined) {
      return;
    }
  }
}

function refreshCommit(
  configuration: RefreshConfiguration,
  stateDir: string,
  commit: string,
): void {
  const started = Date.now();
  const { healthyDir, candidateDir } = configuration;
  command(healthyDir, "git", ["fetch", "origin", "main"]);
  requireMainCommit(healthyDir, commit);
  const completed = readRefreshCompletion(stateDir);
  if (
    completed !== undefined &&
    completed.commit !== commit &&
    isCommitAncestor(healthyDir, commit, completed.commit)
  ) {
    throw new Error(
      `Refusing to refresh older commit ${commit}; ${completed.commit} is already healthy`,
    );
  }
  command(candidateDir, "git", ["checkout", "--detach", commit]);
  requireCleanCheckout(candidateDir);

  const candidateIndex = path.join(candidateDir, ".repowise");
  const healthyIndex = path.join(healthyDir, ".repowise");
  rmSync(candidateIndex, { recursive: true, force: true });

  let recovery: RefreshCompletion["recovery"] = "incremental";
  if (existsSync(healthyIndex)) {
    cpSync(healthyIndex, candidateIndex, { recursive: true });
    const previousCommit = readIndexedCommit(candidateIndex);
    try {
      runIncrementalRefresh(candidateDir, previousCommit);
      validateCandidate(candidateDir, commit);
    } catch (error) {
      recovery = "empty-rebuild";
      appendLog(
        stateDir,
        `incremental refresh ${commit} rejected; rebuilding from empty store: ${errorMessage(error)}`,
      );
      runEmptyRebuild(candidateDir, healthyIndex);
      validateCandidate(candidateDir, commit);
    }
  } else {
    recovery = "empty-rebuild";
    runEmptyRebuild(candidateDir);
    validateCandidate(candidateDir, commit);
  }

  command(healthyDir, "git", ["checkout", "--detach", commit]);
  requireCleanCheckout(healthyDir);
  promoteCandidateIndex(configuration, stateDir);
  try {
    validateCandidate(healthyDir, commit);
  } catch (error) {
    rollbackPromotion(configuration, stateDir);
    throw error;
  }
  rmSync(path.join(stateDir, "previous-index"), {
    recursive: true,
    force: true,
  });
  rmSync(path.join(stateDir, "rejected-index"), {
    recursive: true,
    force: true,
  });

  const completion: RefreshCompletion = {
    schemaVersion: 1,
    commit,
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - started) / 1000),
    recovery,
    modelPolicy: { prose: false, provider: "mock", model: "mock" },
  };
  writeJsonAtomically(path.join(stateDir, COMPLETION_FILE), completion);

  try {
    command(configuration.bridgeDir, "npm", [
      "run",
      "upload:repowise-input",
      "--",
      "--framework-dir",
      healthyDir,
      "--environment",
      configuration.environment,
      "--attempts",
      "4",
    ]);
  } catch (error) {
    appendLog(
      stateDir,
      `upload deferred; durable queue retained: ${errorMessage(error)}`,
    );
  }
  appendLog(
    stateDir,
    `healthy ${commit} via ${recovery} in ${completion.durationSeconds}s; model policy no-prose/mock`,
  );
}

function runIncrementalRefresh(
  directory: string,
  previousCommit: string,
): void {
  command(
    directory,
    "repowise",
    [
      "update",
      "--no-workspace",
      "--index-only",
      "--no-agents",
      "--provider",
      "mock",
      "--model",
      "mock",
      "--since",
      previousCommit,
    ],
    { REPOWISE_SKIP_EDITOR_SETUP: "1" },
  );
}

function runEmptyRebuild(directory: string, sourceIndex?: string): void {
  const index = path.join(directory, ".repowise");
  rmSync(index, { recursive: true, force: true });
  mkdirSync(index, { recursive: true, mode: 0o700 });
  if (sourceIndex !== undefined) copyRepowiseConfiguration(sourceIndex, index);
  command(
    directory,
    "repowise",
    [
      "init",
      "--yes",
      "--no-workspace",
      "--no-agents",
      "--no-codex",
      "--no-distill-hook",
      "--no-prose",
      "--no-seed",
      "--provider",
      "mock",
      "--model",
      "mock",
      "--progress",
      "json",
    ],
    { REPOWISE_SKIP_EDITOR_SETUP: "1" },
  );
  if (sourceIndex !== undefined) {
    copyRepowiseConfiguration(sourceIndex, index);
    copyDurableUploadQueue(sourceIndex, index);
  }
}

function validateCandidate(directory: string, expectedCommit: string): void {
  const report = JSON.parse(
    command(directory, "repowise", [
      "doctor",
      "--no-workspace",
      "--format",
      "json",
    ]),
  ) as unknown;
  validateRepowiseHealth(
    report,
    readIndexedCommit(path.join(directory, ".repowise")),
    expectedCommit,
  );
}

function promoteCandidateIndex(
  configuration: RefreshConfiguration,
  stateDir: string,
): void {
  const healthyIndex = path.join(configuration.healthyDir, ".repowise");
  const candidateIndex = path.join(configuration.candidateDir, ".repowise");
  const previousIndex = path.join(stateDir, "previous-index");
  const rejectedIndex = path.join(stateDir, "rejected-index");
  copyDurableUploadQueue(healthyIndex, candidateIndex);
  copyDurableUploadQueue(rejectedIndex, candidateIndex);
  rmSync(previousIndex, { recursive: true, force: true });
  if (existsSync(healthyIndex)) renameSync(healthyIndex, previousIndex);
  try {
    renameSync(candidateIndex, healthyIndex);
  } catch (error) {
    if (!existsSync(healthyIndex) && existsSync(previousIndex)) {
      renameSync(previousIndex, healthyIndex);
    }
    throw error;
  }
}

function rollbackPromotion(
  configuration: RefreshConfiguration,
  stateDir: string,
): void {
  const healthyIndex = path.join(configuration.healthyDir, ".repowise");
  const previousIndex = path.join(stateDir, "previous-index");
  const rejectedIndex = path.join(stateDir, "rejected-index");
  if (existsSync(previousIndex)) {
    copyDurableUploadQueue(healthyIndex, previousIndex);
    copyDurableUploadQueue(rejectedIndex, previousIndex);
  }
  rmSync(rejectedIndex, { recursive: true, force: true });
  if (existsSync(healthyIndex)) renameSync(healthyIndex, rejectedIndex);
  if (existsSync(previousIndex)) {
    renameSync(previousIndex, healthyIndex);
    const previousCommit = readIndexedCommit(healthyIndex);
    command(configuration.healthyDir, "git", [
      "checkout",
      "--detach",
      previousCommit,
    ]);
    requireCleanCheckout(configuration.healthyDir);
  }
}

function recoverInterruptedPromotion(
  configuration: RefreshConfiguration,
  stateDir: string,
): void {
  const previousIndex = path.join(stateDir, "previous-index");
  if (existsSync(previousIndex)) {
    rollbackPromotion(configuration, stateDir);
  }
}

function requireMainCommit(directory: string, commit: string): void {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", commit, "origin/main"],
    { cwd: directory, stdio: "ignore" },
  );
  if (result.status !== 0) {
    throw new Error(`Refresh commit ${commit} is not present on origin/main`);
  }
}

function requireCleanCheckout(directory: string): void {
  const status = command(directory, "git", ["status", "--porcelain"]);
  if (status.trim() !== "") {
    throw new Error(`Dedicated Repowise checkout is dirty: ${directory}`);
  }
}

function readIndexedCommit(indexDirectory: string): string {
  const parsed = readJson(path.join(indexDirectory, "state.json"));
  if (!isRecord(parsed)) throw new Error("Repowise state.json is invalid");
  const commit = parsed.last_sync_commit ?? parsed.last_sync;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      "Repowise state.json does not contain a full indexed commit",
    );
  }
  return commit;
}

function copyRepowiseConfiguration(source: string, target: string): void {
  for (const name of ["config.yaml", ".env"]) {
    const file = path.join(source, name);
    if (existsSync(file)) {
      const destination = path.join(target, name);
      copyFileSync(file, destination);
      if (name === ".env") chmodSync(destination, 0o600);
    }
  }
}

function copyDurableUploadQueue(
  sourceIndex: string,
  targetIndex: string,
): void {
  const source = path.join(sourceIndex, "tpf-mcp-upload-queue");
  if (!existsSync(source)) return;
  const target = path.join(targetIndex, "tpf-mcp-upload-queue");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{40}$/.test(entry.name)) continue;
    cpSync(path.join(source, entry.name), path.join(target, entry.name), {
      recursive: true,
    });
  }
}

function lockOwnerIsAlive(lock: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(lock, "utf8")) as unknown;
    if (!isRecord(parsed) || typeof parsed.pid !== "number") {
      return lockIsWithinGracePeriod(lock);
    }
    const pid = parsed.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return lockIsWithinGracePeriod(lock);
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "EPERM") return true;
    if (isRecord(error) && error.code === "ESRCH") return false;
    return lockIsWithinGracePeriod(lock);
  }
}

function lockIsWithinGracePeriod(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs < PARTIAL_LOCK_GRACE_MS;
  } catch {
    return true;
  }
}

function readRefreshFailure(
  stateDir: string,
): { commit: string; failedAt: string; reason: string } | undefined {
  const file = path.join(stateDir, FAILURE_FILE);
  if (!existsSync(file)) return undefined;
  const value = readJson(file);
  if (
    !isRecord(value) ||
    typeof value.commit !== "string" ||
    typeof value.failedAt !== "string" ||
    typeof value.reason !== "string"
  ) {
    throw new Error(`Invalid failed refresh record in ${stateDir}`);
  }
  return {
    commit: value.commit,
    failedAt: value.failedAt,
    reason: value.reason,
  };
}

function readRefreshCompletion(
  stateDir: string,
): RefreshCompletion | undefined {
  const file = path.join(stateDir, COMPLETION_FILE);
  if (!existsSync(file)) return undefined;
  const value = readJson(file);
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.commit) ||
    typeof value.completedAt !== "string" ||
    typeof value.durationSeconds !== "number" ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds < 0 ||
    (value.recovery !== "incremental" && value.recovery !== "empty-rebuild") ||
    !isRecord(value.modelPolicy) ||
    value.modelPolicy.prose !== false ||
    value.modelPolicy.provider !== "mock" ||
    value.modelPolicy.model !== "mock"
  ) {
    throw new Error(`Invalid completed refresh record in ${stateDir}`);
  }
  return value as unknown as RefreshCompletion;
}

function isCommitAncestor(
  directory: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: directory, stdio: "ignore" },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `Could not compare Repowise refresh commits ${ancestor} and ${descendant}`,
  );
}

function isKnownCommit(directory: string, commit: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: directory,
      stdio: "ignore",
    }).status === 0
  );
}

function command(
  directory: string,
  executable: string,
  args: string[],
  environment: Record<string, string> = {},
  timeoutMs = 45 * 60 * 1000,
): string {
  try {
    return execFileSync(executable, args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...environment },
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      isRecord(error) && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new Error(
      stderr === "" ? errorMessage(error) : `${errorMessage(error)}: ${stderr}`,
      { cause: error },
    );
  }
}

function appendLog(stateDir: string, message: string): void {
  writeFileSync(
    path.join(stateDir, "refresh.log"),
    `${new Date().toISOString()} ${message}\n`,
    { flag: "a" },
  );
}

function writeJsonAtomically(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function isDoctorReport(value: unknown): value is DoctorReport {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.checks) &&
    value.checks.every(
      (check) =>
        isRecord(check) &&
        typeof check.name === "string" &&
        typeof check.ok === "boolean" &&
        typeof check.detail === "string",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
