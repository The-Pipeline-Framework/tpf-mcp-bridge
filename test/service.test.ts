import { describe, expect, it } from "vitest";

import { KnowledgeService } from "../src/service.js";
import type { KnowledgeRepository } from "../src/types.js";

const release = {
  version: "26.7.1",
  kind: "RELEASE" as const,
  frameworkCommit: "abc123",
  publishedAt: "2026-07-01T00:00:00Z",
  bundleChecksum: "bundle",
  repowiseVersion: "0.43.0",
};

function repository(): KnowledgeRepository {
  return {
    async listVersions() {
      return [release];
    },
    async search(request) {
      return [
        {
          id: "one",
          scope: request.scope ?? "docs",
          title: "Commands",
          path: "docs/develop/commands.md",
          snippet: "typed command",
          citation: "citation",
        },
      ];
    },
    async getPages(_version, ids) {
      return ids.map((id) => ({
        id,
        scope: "docs",
        title: id,
        path: `docs/${id}.md`,
        content: "content",
        citation: "citation",
      }));
    },
    async getSource(_version, filePath, startLine, endLine) {
      return {
        path: filePath,
        startLine,
        endLine,
        content: "source",
        citation: "citation",
      };
    },
  };
}

describe("KnowledgeService", () => {
  it("requires an exact supported version without fallback", async () => {
    const service = new KnowledgeService(repository());
    await expect(
      service.search("26.7.0", "command", undefined),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
      message:
        "Unsupported TPF version '26.7.0'. Available exact versions: 26.7.1",
    });
  });

  it("bounds search, context and source inputs", async () => {
    const service = new KnowledgeService(repository());
    await expect(
      service.search(release.version, "x", undefined, 21),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.context(release.version, ["1", "2", "3", "4", "5", "6"]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.source(release.version, "../AGENTS.md", 1, 2),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.source(release.version, "docs/develop/x.md", 1, 201),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.search(release.version, "x", undefined, 20),
    ).resolves.toBeDefined();
    await expect(
      service.context(release.version, ["1", "2", "3", "4", "5"]),
    ).resolves.toHaveLength(5);
    await expect(
      service.source(release.version, "docs/develop/x.md", 1, 200),
    ).resolves.toBeDefined();
  });

  it("reports missing context IDs", async () => {
    const base = repository();
    base.getPages = async (_version, ids) =>
      ids
        .filter((id) => id !== "missing")
        .map((id) => ({
          id,
          scope: "docs",
          title: id,
          path: `docs/${id}.md`,
          content: "content",
          citation: "citation",
        }));
    const service = new KnowledgeService(base);
    await expect(
      service.context(release.version, ["found", "missing"]),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Knowledge result not found for 26.7.1: missing",
    });
  });

  it("reports a missing approved source path", async () => {
    const base = repository();
    base.getSource = async () => undefined;
    const service = new KnowledgeService(base);

    await expect(
      service.source(release.version, "docs/develop/missing.md", 1, 20),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message:
        "Approved source path not found for 26.7.1: docs/develop/missing.md",
    });
  });

  it("bounds aggregate context including its truncation marker", async () => {
    const base = repository();
    base.getPages = async (_version, ids) =>
      ids.map((id) => ({
        id,
        scope: "docs",
        title: id,
        path: `docs/${id}.md`,
        content: "x".repeat(60_000),
        citation: "citation",
      }));
    const pages = await new KnowledgeService(base).context(release.version, [
      "one",
      "two",
    ]);
    expect(pages.map((page) => page.content).join("").length).toBe(50_000);
    expect(
      pages[0].content.endsWith("[content truncated by MCP response limit]"),
    ).toBe(true);
    expect(
      pages[1].content.endsWith("[content truncated by MCP response limit]"),
    ).toBe(true);
  });
});
