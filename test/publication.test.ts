import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyAuthorPath,
  compileBundle,
  planImmutableReleasePublication,
  supportedMinorLines,
  validateImmutableRelease,
  verifyFrameworkRelease,
  verifyFrameworkSnapshot,
  writeBundle,
} from "../src/publication.js";
import {
  parseStoredRepowiseInputManifest,
  readRepowiseInput,
  validateImmutableRepowiseInput,
  validateRepowiseHealthReport,
} from "../src/repowise-input.js";
import {
  acquireRepowiseQueueLock,
  listQueuedRepowiseInputs,
  removeQueuedRepowiseInput,
  stageRepowiseInput,
} from "../src/repowise-queue.js";
import {
  acquireRefreshLock,
  readRequestedRefresh,
  requestRepowiseRefresh,
  validateRepowiseHealth,
  writeRefreshConfiguration,
} from "../src/repowise-refresh.js";

describe("author knowledge publication", () => {
  it("admits author surfaces and rejects maintainer material", () => {
    expect(classifyAuthorPath("docs/develop/code-a-step.md")).toBe("docs");
    expect(classifyAuthorPath(".agents/skills/tpf-authoring/SKILL.md")).toBe(
      "skill",
    );
    expect(classifyAuthorPath("examples/csv-payments/pipeline.yaml")).toBe(
      "examples",
    );
    expect(
      classifyAuthorPath(
        "framework/runtime-core/src/main/java/org/pipelineframework/PipelineStep.java",
      ),
    ).toBe("api");
    expect(classifyAuthorPath("docs/decisions/001-command.md")).toBeUndefined();
    expect(classifyAuthorPath("docs/evolve/roadmap.md")).toBeUndefined();
    expect(
      classifyAuthorPath("docs/develop/../../decisions/001.md"),
    ).toBeUndefined();
    expect(classifyAuthorPath("/docs/develop/author.md")).toBeUndefined();
    expect(
      classifyAuthorPath(
        "framework/deployment/src/main/java/internal/Processor.java",
      ),
    ).toBeUndefined();
  });

  it("produces deterministic scoped bundles and immutable object keys", () => {
    const frameworkDir = fixtureRepository();
    const exportBytes = Buffer.from(
      JSON.stringify({
        pages: [
          {
            page_id: "docs",
            title: "Author docs",
            content: "How to author",
            target_path: "docs/develop/author.md",
          },
          {
            page_id: "adr",
            title: "Maintainer ADR",
            content: "Internal",
            target_path: "docs/decisions/001.md",
          },
        ],
      }),
    );
    const input = {
      frameworkDir,
      version: "26.7.1",
      frameworkCommit: "a".repeat(40),
      publishedAt: "2026-07-01T00:00:00Z",
      repowiseVersion: "0.43.0",
      repowiseExportBytes: exportBytes,
    };
    const first = compileBundle(input);
    const second = compileBundle(input);
    expect(first.manifest.bundleChecksum).toBe(second.manifest.bundleChecksum);
    expect(first.manifest).toMatchObject({
      schemaVersion: 2,
      kind: "RELEASE",
    });
    expect(first.documents).toHaveLength(2);
    expect(first.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "docs",
          path: "docs/develop/author.md",
          content: "How to author",
        }),
      ]),
    );
    expect(first.sources.map((source) => source.path)).toEqual([
      "docs/develop/author.md",
    ]);
    expect(first.documents[0].objectKey).toContain(
      first.manifest.bundleChecksum,
    );

    const output = path.join(frameworkDir, "bundle");
    writeBundle(first, output);
    expect(
      JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8")),
    ).toMatchObject({ documentCount: 2, sourceCount: 1 });
    expect(readFileSync(path.join(output, "stage.sql"), "utf8")).not.toContain(
      "Maintainer ADR",
    );
    expect(readFileSync(path.join(output, "stage.sql"), "utf8")).not.toMatch(
      /\b(?:BEGIN|COMMIT)\b/,
    );
  });

  it("bounds staging chunks by bytes without splitting document statements", () => {
    const frameworkDir = fixtureRepository();
    const pages = Array.from({ length: 120 }, (_, index) => ({
      page_id: `page-${index}`,
      title: `Page ${index}`,
      content: `${String(index).padStart(3, "0")}:${"x".repeat(16_000)}`,
      target_path: "docs/develop/author.md",
    }));
    const bundle = compileBundle({
      frameworkDir,
      version: "26.7.1",
      frameworkCommit: "b".repeat(40),
      publishedAt: "2026-07-01T00:00:00Z",
      repowiseVersion: "0.43.0",
      repowiseExportBytes: Buffer.from(JSON.stringify({ pages })),
    });
    const output = path.join(frameworkDir, "byte-bounded-bundle");

    writeBundle(bundle, output);

    const chunks = JSON.parse(
      readFileSync(path.join(output, "stage-chunks.json"), "utf8"),
    ) as string[];
    const chunkSql = chunks.map((chunk) =>
      readFileSync(path.join(output, chunk), "utf8"),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(10);
    expect(chunkSql.every((sql) => Buffer.byteLength(sql) <= 1024 * 1024)).toBe(
      true,
    );
    for (const sql of chunkSql) {
      expect(sql.match(/INSERT OR REPLACE INTO documents /g)?.length ?? 0).toBe(
        sql.match(/INSERT INTO documents_fts /g)?.length ?? 0,
      );
    }
  });

  it("indexes authoritative author docs and skill Markdown when Repowise emits no pages", () => {
    const frameworkDir = fixtureRepository();
    mkdirSync(path.join(frameworkDir, ".agents/skills/tpf-authoring"), {
      recursive: true,
    });
    writeFileSync(
      path.join(frameworkDir, ".agents/skills/tpf-authoring/SKILL.md"),
      "# TPF authoring\n\nRepeated fields use immutable List values and nested records.\n",
    );
    writeFileSync(
      path.join(frameworkDir, "docs/develop/author.md"),
      "# Pipeline types\n\nUse discriminated unions for variant output.\n",
    );
    execFileSync("git", ["add", "."], { cwd: frameworkDir });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--no-gpg-sign",
        "-qm",
        "author guidance",
      ],
      { cwd: frameworkDir },
    );

    const bundle = compileBundle({
      frameworkDir,
      version: "26.7.1",
      frameworkCommit: "a".repeat(40),
      publishedAt: "2026-07-01T00:00:00Z",
      repowiseVersion: "0.43.0",
      repowiseExportBytes: Buffer.from('{"pages":[]}'),
    });

    expect(bundle.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "docs",
          title: "Pipeline types",
          content: expect.stringContaining("discriminated unions"),
        }),
        expect.objectContaining({
          scope: "skill",
          title: "TPF authoring",
          content: expect.stringContaining("Repeated fields"),
        }),
      ]),
    );
  });

  it("rejects duplicate generated document identities before staging", () => {
    const frameworkDir = fixtureRepository();
    const repowiseExportBytes = Buffer.from(
      JSON.stringify({
        pages: [
          {
            page_id: "same",
            title: "First",
            content: "one",
            target_path: "docs/develop/author.md",
          },
          {
            page_id: "same",
            title: "Second",
            content: "two",
            target_path: "docs/develop/author.md",
          },
        ],
      }),
    );
    expect(() =>
      compileBundle({
        frameworkDir,
        version: "26.7.1",
        frameworkCommit: "a".repeat(40),
        publishedAt: "2026-07-01T00:00:00Z",
        repowiseVersion: "0.43.0",
        repowiseExportBytes,
      }),
    ).toThrow("duplicate document IDs");
  });

  it("keeps the newest three minor lines", () => {
    expect([
      ...supportedMinorLines([
        "26.4.4",
        "26.5.1",
        "26.5.2",
        "26.6.1",
        "26.7.1",
      ]),
    ]).toEqual(["26.7", "26.6", "26.5"]);
  });

  it("requires a clean checkout at the exact release tag", () => {
    const frameworkDir = fixtureRepository();
    expect(verifyFrameworkRelease(frameworkDir, "26.7.1").commit).toHaveLength(
      40,
    );
    writeFileSync(
      path.join(frameworkDir, "docs/develop/author.md"),
      "changed\n",
    );
    expect(() => verifyFrameworkRelease(frameworkDir, "26.7.1")).toThrow(
      "Framework checkout must be clean",
    );
  });

  it("reports an actionable exact-tag error for an untagged checkout", () => {
    const frameworkDir = fixtureRepository(false);
    expect(() => verifyFrameworkRelease(frameworkDir, "26.7.1")).toThrow(
      "found 'no tag'",
    );
  });

  it("publishes a mutable snapshot alias over immutable commit objects", () => {
    const frameworkDir = fixtureRepository(false, "26.8.2-SNAPSHOT");
    const framework = verifyFrameworkSnapshot(frameworkDir, "26.8.2-SNAPSHOT");
    const bundle = compileBundle({
      frameworkDir,
      version: "26.8.2-SNAPSHOT",
      frameworkCommit: framework.commit,
      publishedAt: framework.publishedAt,
      repowiseVersion: "0.43.0",
      repowiseExportBytes: Buffer.from(
        JSON.stringify({
          pages: [
            {
              page_id: "docs",
              title: "Snapshot docs",
              content: "Current main knowledge",
              target_path: "docs/develop/author.md",
            },
          ],
        }),
      ),
      kind: "SNAPSHOT",
    });
    expect(bundle.manifest.kind).toBe("SNAPSHOT");
    expect(bundle.documents[0].objectKey).toContain(
      `snapshots/26.8.2-SNAPSHOT/${framework.commit}/${bundle.manifest.bundleChecksum}`,
    );

    const output = path.join(frameworkDir, "snapshot-bundle");
    writeBundle(bundle, output);
    const stage = readFileSync(path.join(output, "stage.sql"), "utf8");
    const activate = readFileSync(path.join(output, "activate.sql"), "utf8");
    const chunks = JSON.parse(
      readFileSync(path.join(output, "stage-chunks.json"), "utf8"),
    ) as string[];
    expect(stage).toContain("INSERT OR IGNORE INTO releases");
    expect(stage).toContain("DELETE FROM documents_fts");
    expect(stage.match(/DELETE FROM documents_fts/g)).toHaveLength(1);
    expect(stage).toContain(
      `DELETE FROM documents_fts WHERE version = '${bundle.manifest.datasetVersion}';`,
    );
    expect(stage).not.toMatch(/DELETE FROM documents_fts[^;]+\bAND\s+id\b/);
    expect(stage).toContain("INSERT OR REPLACE INTO documents");
    expect(stage).toContain("'SNAPSHOT'");
    expect(stage).toContain("'STAGED', 0");
    expect(chunks.length).toBeGreaterThan(0);
    const chunkSql = chunks.map((chunk) =>
      readFileSync(path.join(output, chunk), "utf8"),
    );
    expect(chunkSql.every((sql) => sql.endsWith("\n"))).toBe(true);
    expect(
      chunkSql.join("\n").match(/DELETE FROM documents_fts/g),
    ).toHaveLength(1);
    expect(chunkSql[0]).toContain("DELETE FROM documents_fts");
    expect(activate).toContain(bundle.manifest.datasetVersion);
    expect(activate).toContain(
      `VALUES ('26.8.2-SNAPSHOT', '${bundle.manifest.datasetVersion}')`,
    );
    expect(stage).not.toMatch(/\b(?:BEGIN|COMMIT)\b/);
  });

  it("requires the exact clean root project snapshot version", () => {
    const frameworkDir = fixtureRepository(false, "26.8.2-SNAPSHOT");
    expect(() =>
      verifyFrameworkSnapshot(frameworkDir, "26.8.3-SNAPSHOT"),
    ).toThrow("root project version must be 26.8.3-SNAPSHOT");
    writeFileSync(
      path.join(frameworkDir, "docs/develop/author.md"),
      "changed\n",
    );
    expect(() =>
      verifyFrameworkSnapshot(frameworkDir, "26.8.2-SNAPSHOT"),
    ).toThrow("Framework checkout must be clean");
  });

  it("accepts only an exact commit-addressed Repowise input manifest", () => {
    const commit = "a".repeat(40);
    const manifest = {
      schemaVersion: 1,
      frameworkCommit: commit,
      repowiseVersion: "0.43.0",
      exportChecksum: "b".repeat(64),
      sourceCommittedAt: "2026-07-01T00:00:00Z",
    };
    expect(parseStoredRepowiseInputManifest(manifest, commit)).toEqual(
      manifest,
    );
    expect(() =>
      parseStoredRepowiseInputManifest(manifest, "c".repeat(40)),
    ).toThrow("does not match framework commit");
    expect(() =>
      parseStoredRepowiseInputManifest(
        { ...manifest, exportChecksum: "not-a-checksum" },
        commit,
      ),
    ).toThrow("invalid provenance fields");
  });

  it("rejects stale or commit-mismatched Repowise state", () => {
    const commit = "a".repeat(40);
    expect(() =>
      validateRepowiseHealthReport(
        { stale_pages: 0, indexed_commit: commit },
        { last_docs_commit: "b".repeat(40) },
        commit,
      ),
    ).not.toThrow();
    expect(() =>
      validateRepowiseHealthReport(
        { stale_pages: 1, indexed_commit: commit },
        {},
        commit,
      ),
    ).toThrow("stale pages: 1");
    expect(() =>
      validateRepowiseHealthReport(
        { stale_pages: 0, indexed_commit: "b".repeat(40) },
        {},
        commit,
      ),
    ).toThrow("does not match framework commit");
  });

  it("enforces immutable input/release checksums and stored export bytes", () => {
    expect(validateImmutableRepowiseInput(undefined, "one")).toBe("UPLOAD");
    expect(validateImmutableRepowiseInput("one", "one")).toBe("NOOP");
    expect(() => validateImmutableRepowiseInput("one", "two")).toThrow(
      "different checksum",
    );
    expect(validateImmutableRelease([], "one")).toBe("CREATE");
    expect(validateImmutableRelease(["one"], "one")).toBe("EXISTS");
    expect(() => validateImmutableRelease(["one"], "two")).toThrow(
      "different immutable checksum",
    );

    const directory = mkdtempSync(path.join(os.tmpdir(), "tpf-input-test-"));
    const file = path.join(directory, "export.json");
    writeFileSync(file, '{"pages":[]}');
    const checksum = createHash("sha256").update('{"pages":[]}').digest("hex");
    expect(readRepowiseInput(file, "0.43.0", checksum).checksum).toBe(checksum);
    expect(() => readRepowiseInput(file, "0.43.0", "0".repeat(64))).toThrow(
      "does not match declared",
    );
  });

  it("restages an incomplete immutable release before activation", () => {
    expect(planImmutableReleasePublication([], [], "one", true)).toBe("CREATE");
    expect(
      planImmutableReleasePublication(["one"], ["STAGED"], "one", true),
    ).toBe("RESTAGE");
    expect(
      planImmutableReleasePublication(["one"], ["ACTIVE"], "one", true),
    ).toBe("NOOP");
    expect(
      planImmutableReleasePublication(["one"], ["STAGED"], "one", false),
    ).toBe("NOOP");
    expect(() =>
      planImmutableReleasePublication(["different"], ["STAGED"], "one", true),
    ).toThrow("different immutable checksum");
  });

  it("durably queues immutable exports until delivery succeeds", () => {
    const queue = mkdtempSync(path.join(os.tmpdir(), "tpf-input-queue-test-"));
    const commit = "a".repeat(40);
    const bytes = Buffer.from('{"pages":[]}');
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const manifest = {
      schemaVersion: 1 as const,
      frameworkCommit: commit,
      repowiseVersion: "0.43.0",
      exportChecksum: checksum,
      sourceCommittedAt: "2026-07-01T00:00:00Z",
    };
    const input = { version: "0.43.0", bytes, checksum };

    stageRepowiseInput(queue, manifest, input);
    stageRepowiseInput(queue, manifest, input);
    const queued = listQueuedRepowiseInputs(queue);
    expect(queued).toHaveLength(1);
    expect(queued[0].manifest).toEqual(manifest);
    expect(() =>
      stageRepowiseInput(queue, manifest, {
        ...input,
        bytes: Buffer.from("different"),
        checksum: createHash("sha256").update("different").digest("hex"),
      }),
    ).toThrow("different checksum");

    const release = acquireRepowiseQueueLock(queue);
    expect(release).toBeTypeOf("function");
    expect(acquireRepowiseQueueLock(queue)).toBeUndefined();
    release?.();
    const releaseAgain = acquireRepowiseQueueLock(queue);
    expect(releaseAgain).toBeTypeOf("function");
    releaseAgain?.();

    removeQueuedRepowiseInput(queued[0]);
    expect(listQueuedRepowiseInputs(queue)).toEqual([]);
  });

  it("installs idempotent commit, merge and retry hooks", () => {
    const frameworkDir = mkdtempSync(
      path.join(os.tmpdir(), "tpf-hook-install-test-"),
    );
    const gitEnvironment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(frameworkDir, "missing-global-gitconfig"),
      GIT_CONFIG_SYSTEM: path.join(frameworkDir, "missing-system-gitconfig"),
    };
    execFileSync("git", ["init", "-q", "--initial-branch=main"], {
      cwd: frameworkDir,
      env: gitEnvironment,
    });
    writeFileSync(path.join(frameworkDir, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], {
      cwd: frameworkDir,
      env: gitEnvironment,
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--no-gpg-sign",
        "-qm",
        "fixture",
      ],
      { cwd: frameworkDir, env: gitEnvironment },
    );
    const hooks = path.join(frameworkDir, ".git", "hooks");
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "tpf-refresh-state-test-"),
    );
    const postCommit = path.join(hooks, "post-commit");
    writeFileSync(
      path.join(hooks, "post-merge"),
      "#!/bin/sh\nexec /bin/true\n",
      { mode: 0o755 },
    );
    writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\n", {
      mode: 0o644,
    });
    writeFileSync(
      postCommit,
      [
        "#!/bin/sh",
        "# repowise-hook-start",
        "{",
        "  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0",
        '  LOG="$ROOT/.repowise/.update.log"',
        "  (",
        '    cd "$ROOT" || exit 1',
        '    repowise update --workspace --repo pipelineframework >> "$LOG" 2>&1',
        "  ) &",
        "} >/dev/null 2>&1",
        "# repowise-hook-end",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const installer = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const install = (targetStateDir = stateDir) =>
      execFileSync(
        process.execPath,
        [
          installer,
          "scripts/install-repowise-upload-hook.ts",
          "--framework-dir",
          frameworkDir,
          "--environment",
          "staging",
          "--state-dir",
          targetStateDir,
        ],
        {
          cwd: path.resolve("."),
          stdio: "pipe",
          env: gitEnvironment,
        },
      );

    install();
    install();
    const candidateDir = path.join(realpathSync(stateDir), "candidate");
    rmSync(candidateDir, { recursive: true, force: true });
    mkdirSync(candidateDir);
    install();
    const commitHook = readFileSync(postCommit, "utf8");
    const mergeHook = readFileSync(path.join(hooks, "post-merge"), "utf8");
    const checkoutHook = readFileSync(
      path.join(hooks, "post-checkout"),
      "utf8",
    );
    expect(commitHook.match(/# tpf-mcp-refresh-start/g)).toHaveLength(1);
    expect(commitHook).toContain("scripts/refresh-repowise.ts");
    expect(commitHook).toContain(`--state-dir '${realpathSync(stateDir)}'`);
    expect(commitHook).toContain(`--commit "$HEAD"`);
    expect(commitHook).not.toContain("# tpf-mcp-upload-start");
    expect(mergeHook.match(/# tpf-mcp-refresh-start/g)).toHaveLength(1);
    expect(mergeHook).toContain(
      `[ "$ROOT" = '${realpathSync(frameworkDir)}' ] || exit 0`,
    );
    expect(mergeHook.indexOf("# tpf-mcp-refresh-start")).toBeLessThan(
      mergeHook.indexOf("exec /bin/true"),
    );
    expect(checkoutHook.match(/# tpf-mcp-refresh-start/g)).toHaveLength(1);
    expect(checkoutHook).toContain(`[ "\${3:-0}" = '1' ] || exit 0`);
    expect(existsSync(path.join(stateDir, "framework", ".git"))).toBe(true);
    expect(existsSync(path.join(stateDir, "candidate", ".git"))).toBe(true);
    expect(
      JSON.parse(
        readFileSync(path.join(stateDir, "refresh-config.json"), "utf8"),
      ),
    ).toMatchObject({ environment: "staging" });
    for (const hook of [
      postCommit,
      path.join(hooks, "post-merge"),
      path.join(hooks, "post-checkout"),
    ]) {
      execFileSync("sh", ["-n", hook]);
      expect(statSync(hook).mode & 0o111).toBe(0o111);
    }

    const invalidStateDir = path.join(frameworkDir, ".repowise-refresh");
    expect(() => install(invalidStateDir)).toThrow();
    expect(existsSync(invalidStateDir)).toBe(false);
    expect(() => install(path.dirname(realpathSync(frameworkDir)))).toThrow();
  });

  it("does not replace a healthy completion with an older refresh", () => {
    const frameworkDir = fixtureRepository(false);
    const olderCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: frameworkDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(path.join(frameworkDir, "newer.txt"), "newer\n");
    execFileSync("git", ["add", "newer.txt"], { cwd: frameworkDir });
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--no-gpg-sign",
        "-qm",
        "newer",
      ],
      { cwd: frameworkDir },
    );
    const completedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: frameworkDir,
      encoding: "utf8",
    }).trim();
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "tpf-refresh-order-test-"),
    );
    writeRefreshConfiguration(stateDir, {
      schemaVersion: 1,
      bridgeDir: path.resolve("."),
      healthyDir: frameworkDir,
      candidateDir: path.join(stateDir, "candidate"),
      environment: "staging",
    });
    writeFileSync(
      path.join(stateDir, "completed-refresh.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        commit: completedCommit,
        completedAt: new Date().toISOString(),
        durationSeconds: 1,
        recovery: "incremental",
        modelPolicy: { prose: false, provider: "mock", model: "mock" },
      })}\n`,
    );

    expect(() => requestRepowiseRefresh(stateDir, olderCommit)).toThrow(
      "Refusing to refresh older commit",
    );
    expect(readRequestedRefresh(stateDir)).toBeUndefined();
    expect(() =>
      requestRepowiseRefresh(stateDir, completedCommit),
    ).not.toThrow();
    expect(readRequestedRefresh(stateDir)).toBeUndefined();
  });

  it("coalesces refresh requests behind a single-flight lock", () => {
    const stateDir = mkdtempSync(
      path.join(os.tmpdir(), "tpf-refresh-queue-test-"),
    );
    const first = "a".repeat(40);
    const latest = "b".repeat(40);
    requestRepowiseRefresh(stateDir, first);
    const release = acquireRefreshLock(stateDir);
    expect(release).toBeTypeOf("function");
    requestRepowiseRefresh(stateDir, latest);
    expect(acquireRefreshLock(stateDir)).toBeUndefined();
    expect(readRequestedRefresh(stateDir)?.commit).toBe(latest);
    release?.();
    const releaseAgain = acquireRefreshLock(stateDir);
    expect(releaseAgain).toBeTypeOf("function");
    releaseAgain?.();
    writeFileSync(
      path.join(stateDir, "refresh.lock"),
      `${JSON.stringify({ pid: 999999999, createdAt: new Date().toISOString() })}\n`,
    );
    const releaseStaleOwner = acquireRefreshLock(stateDir);
    expect(releaseStaleOwner).toBeTypeOf("function");
    releaseStaleOwner?.();
    writeFileSync(path.join(stateDir, "refresh.lock"), "");
    expect(acquireRefreshLock(stateDir)).toBeUndefined();
    const expired = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(path.join(stateDir, "refresh.lock"), expired, expired);
    expect(acquireRefreshLock(stateDir)).toBeTypeOf("function");
  });

  it("requires exact commit and every doctor check before promotion", () => {
    const commit = "c".repeat(40);
    const healthy = {
      ok: true,
      checks: [
        { name: "Stale pages", ok: true, detail: "0 stale" },
        { name: "SQL ↔ Vector Store", ok: true, detail: "in sync" },
        { name: "SQL ↔ FTS Index", ok: true, detail: "in sync" },
      ],
    };
    expect(() => validateRepowiseHealth(healthy, commit, commit)).not.toThrow();
    expect(() =>
      validateRepowiseHealth(healthy, "d".repeat(40), commit),
    ).toThrow("commit mismatch");
    expect(() =>
      validateRepowiseHealth(
        {
          ok: false,
          checks: [{ name: "Stale pages", ok: false, detail: "404 stale" }],
        },
        commit,
        commit,
      ),
    ).toThrow("Stale pages: 404 stale");
    expect(() => validateRepowiseHealth({}, commit, commit)).toThrow(
      "invalid doctor response",
    );
    expect(() =>
      validateRepowiseHealth(
        {
          ok: true,
          checks: [{ name: "Stale pages", ok: false, detail: "1 stale" }],
        },
        commit,
        commit,
      ),
    ).toThrow("Stale pages: 1 stale");
  });
});

function fixtureRepository(tag = true, version = "26.7.1"): string {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "tpf-publication-test-"),
  );
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(directory, "missing-global-gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(directory, "missing-system-gitconfig"),
  };
  mkdirSync(path.join(directory, "docs/develop"), { recursive: true });
  mkdirSync(path.join(directory, "docs/decisions"), { recursive: true });
  writeFileSync(
    path.join(directory, "docs/develop/author.md"),
    "How to author\n",
  );
  writeFileSync(
    path.join(directory, "docs/decisions/001.md"),
    "Maintainer only\n",
  );
  writeFileSync(
    path.join(directory, "pom.xml"),
    `<project><modelVersion>4.0.0</modelVersion><groupId>org.example</groupId><artifactId>fixture</artifactId><version>${version}</version></project>\n`,
  );
  execFileSync("git", ["init", "-q"], {
    cwd: directory,
    env: gitEnvironment,
  });
  execFileSync("git", ["add", "."], { cwd: directory, env: gitEnvironment });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--no-gpg-sign",
      "-qm",
      "fixture",
    ],
    { cwd: directory, env: gitEnvironment },
  );
  if (tag)
    execFileSync("git", ["tag", "v26.7.1"], {
      cwd: directory,
      env: gitEnvironment,
    });
  return directory;
}
