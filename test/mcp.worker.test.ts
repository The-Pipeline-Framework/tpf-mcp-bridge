import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO releases (version, framework_commit, published_at, bundle_checksum, repowise_version,
      repowise_export_checksum, status, supported, document_count, source_count)
     VALUES ('26.7.1', 'abc123', '2026-07-01T00:00:00Z', 'bundle', '0.43.0', 'export', 'ACTIVE', 1, 1, 1)`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO documents_fts (version, id, scope, title, content, path) VALUES
      ('26.7.1', 'api-repeated', 'api', 'Repeated', 'repeated Java API member', 'framework/api/Repeated.java'),
      ('26.7.1', 'docs-repeated', 'docs', 'Pipeline types', 'Repeated fields use nested records and immutable List values', 'docs/develop/types.md'),
      ('26.7.1', 'skill-unions', 'skill', 'TPF authoring', 'Use discriminated unions for compiler-known branch applicability', '.agents/skills/tpf-authoring/SKILL.md')`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO knowledge_aliases (public_version, dataset_version)
     VALUES ('26.7.1', '26.7.1')`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO documents (version, id, scope, title, path, object_key, content_checksum)
     VALUES ('26.7.1', 'command-page', 'docs', 'Command authoring', 'docs/develop/command.md::configuration',
       'releases/26.7.1/bundle/pages/command-page.json', 'page')`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO documents_fts (version, id, scope, title, content, path)
     VALUES ('26.7.1', 'command-page', 'docs', 'Command authoring', 'Typed command connector configuration',
       'docs/develop/command.md::configuration')`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE.prepare(
    `INSERT INTO source_files (version, path, object_key, content_checksum, line_count)
     VALUES ('26.7.1', 'docs/develop/command.md', 'releases/26.7.1/bundle/source/docs/develop/command.md', 'source', 3)`,
  ).run();
  await env.TPF_MCP_KNOWLEDGE_OBJECTS.put(
    "releases/26.7.1/bundle/pages/command-page.json",
    JSON.stringify({
      id: "command-page",
      scope: "docs",
      title: "Command authoring",
      path: "docs/develop/command.md::configuration",
      content: "Typed command connector configuration",
    }),
  );
  await env.TPF_MCP_KNOWLEDGE_OBJECTS.put(
    "releases/26.7.1/bundle/source/docs/develop/command.md",
    "line one\nline two\nline three",
  );
});

describe("TPF Author MCP Worker", () => {
  it("reports active knowledge without infrastructure details", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/health"),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      serviceVersion: "1.0.0",
      activeKnowledgeVersions: ["26.7.1"],
    });
  });

  it("serves the four stateless MCP tools", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    expect(response.status).toBe(200);
    const result = (await readMcpResponse(response)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(result.result.tools.map((tool) => tool.name)).toEqual([
      "tpf_versions",
      "tpf_search",
      "tpf_context",
      "tpf_source",
    ]);
  });

  it("searches, resolves context, and reads bounded source through MCP", async () => {
    const search = await callTool("tpf_search", {
      version: "26.7.1",
      query: "command",
      scope: "docs",
    });
    expect(search).toContain("command-page");
    expect(search).toContain("docs/develop/command.md");
    expect(search).not.toContain("command.md%3A%3Aconfiguration");
    const context = await callTool("tpf_context", {
      version: "26.7.1",
      ids: ["command-page"],
    });
    expect(context).toContain("Typed command connector configuration");
    const source = await callTool("tpf_source", {
      version: "26.7.1",
      path: "docs/develop/command.md",
      startLine: 2,
      endLine: 3,
    });
    expect(source).toContain("line two\\nline three");
    const outOfRange = await callTool("tpf_source", {
      version: "26.7.1",
      path: "docs/develop/command.md",
      startLine: 4,
      endLine: 4,
    });
    expect(outOfRange).toContain("NOT_FOUND");
  });

  it("prefers author guidance and requires every term in multi-term searches", async () => {
    const repeated = await callTool("tpf_search", {
      version: "26.7.1",
      query: "repeated",
    });
    expect(repeated.indexOf("docs-repeated")).toBeLessThan(
      repeated.indexOf("api-repeated"),
    );

    const detailed = await callTool("tpf_search", {
      version: "26.7.1",
      query: "repeated fields nested records immutable List",
      scope: "docs",
    });
    expect(detailed).toContain("docs-repeated");

    const union = await callTool("tpf_search", {
      version: "26.7.1",
      query: "discriminated unions",
      scope: "skill",
    });
    expect(union).toContain("skill-unions");

    const partial = await callTool("tpf_search", {
      version: "26.7.1",
      query: "repeated unavailable-term",
      scope: "docs",
    });
    expect(partial).toContain("docs-repeated");
  });

  it("rejects unavailable versions before searching", async () => {
    const result = await callTool("tpf_search", {
      version: "26.7.0",
      query: "command",
    });
    expect(result).toContain("UNSUPPORTED_VERSION");
    expect(result).toContain("26.7.1");
  });

  it("rejects invalid hosts and path traversal", async () => {
    const invalidHost = await exports.default.fetch(
      new Request("https://attacker.example/mcp", { method: "POST" }),
      env,
    );
    expect(invalidHost.status).toBe(403);
    const invalidOrigin = await exports.default.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { Origin: "https://attacker.example" },
      }),
      env,
    );
    expect(invalidOrigin.status).toBe(403);
    const missing = await exports.default.fetch(
      new Request("http://localhost/missing", {
        headers: { Origin: "https://playground.ai.cloudflare.com" },
      }),
      env,
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://playground.ai.cloudflare.com",
    );
    const result = await callTool("tpf_source", {
      version: "26.7.1",
      path: "../AGENTS.md",
    });
    expect(result).toContain("INVALID_INPUT");
  });
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await mcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await readMcpResponse(response)) as {
    result: { content: Array<{ text: string }> };
  };
  return body.result.content[0].text;
}

async function readMcpResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .at(-1);
  if (data === undefined)
    throw new Error(`MCP SSE response contained no data: ${text}`);
  return JSON.parse(data);
}

function mcp(body: unknown): Promise<Response> {
  return exports.default.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}
