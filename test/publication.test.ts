import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyAuthorPath,
  compileBundle,
  supportedMinorLines,
  validateImmutableRelease,
  verifyFrameworkRelease,
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
    expect(first.documents).toHaveLength(1);
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
    ).toMatchObject({ documentCount: 1, sourceCount: 1 });
    expect(readFileSync(path.join(output, "stage.sql"), "utf8")).not.toContain(
      "Maintainer ADR",
    );
    expect(readFileSync(path.join(output, "stage.sql"), "utf8")).not.toMatch(
      /\b(?:BEGIN|COMMIT)\b/,
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
        {},
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
    execFileSync("git", ["init", "-q"], { cwd: frameworkDir });
    const hooks = path.join(frameworkDir, ".git", "hooks");
    const postCommit = path.join(hooks, "post-commit");
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
    const install = () =>
      execFileSync(
        process.execPath,
        [
          installer,
          "scripts/install-repowise-upload-hook.ts",
          "--framework-dir",
          frameworkDir,
          "--environment",
          "staging",
        ],
        { cwd: path.resolve("."), stdio: "pipe" },
      );

    install();
    install();
    const commitHook = readFileSync(postCommit, "utf8");
    const mergeHook = readFileSync(path.join(hooks, "post-merge"), "utf8");
    const checkoutHook = readFileSync(
      path.join(hooks, "post-checkout"),
      "utf8",
    );
    expect(commitHook.match(/# tpf-mcp-upload-start/g)).toHaveLength(1);
    expect(commitHook).toContain("--environment staging --attempts 4");
    expect(commitHook).toContain(`if [ "$ROOT" = '${frameworkDir}' ]; then`);
    expect(mergeHook.match(/# tpf-mcp-post-merge-start/g)).toHaveLength(1);
    expect(mergeHook).toContain(
      "repowise update --workspace --repo pipelineframework",
    );
    expect(mergeHook).toContain(`[ "$ROOT" = '${frameworkDir}' ] || exit 0`);
    expect(checkoutHook.match(/# tpf-mcp-post-checkout-start/g)).toHaveLength(
      1,
    );
    expect(checkoutHook).toContain("--retry-only --attempts 2");
    for (const hook of [
      postCommit,
      path.join(hooks, "post-merge"),
      path.join(hooks, "post-checkout"),
    ])
      execFileSync("sh", ["-n", hook]);
  });
});

function fixtureRepository(tag = true): string {
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
