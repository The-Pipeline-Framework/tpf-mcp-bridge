import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { KnowledgeService } from "./service.js";
import { KNOWLEDGE_SCOPES, KnowledgeError } from "./types.js";

export function createTpfMcpServer(service: KnowledgeService): McpServer {
  const server = new McpServer({
    name: "tpf-author-knowledge",
    version: "1.0.0",
  });

  server.registerTool(
    "tpf_versions",
    {
      description:
        "List the exact released and snapshot TPF versions currently supported by this author knowledge service, including each version's publication kind, exact Git commit, and checksum.",
      inputSchema: z.object({}),
    },
    () => invoke(() => service.listVersions()),
  );

  server.registerTool(
    "tpf_search",
    {
      description:
        "Search author-facing TPF documentation, public APIs, examples, or the authoring skill for one exact TPF version. Read the application's pinned TPF version before calling; no version fallback occurs.",
      inputSchema: z.object({
        version: z.string().min(1),
        query: z.string().min(1).max(500),
        scope: z.enum(KNOWLEDGE_SCOPES).optional(),
        maxResults: z.number().int().min(1).max(20).default(8),
      }),
    },
    ({ version, query, scope, maxResults }) =>
      invoke(() => service.search(version, query, scope, maxResults)),
  );

  server.registerTool(
    "tpf_context",
    {
      description:
        "Retrieve complete, bounded author-facing knowledge pages returned by tpf_search for the same exact TPF version.",
      inputSchema: z.object({
        version: z.string().min(1),
        ids: z.array(z.string().min(1)).min(1).max(5),
      }),
    },
    ({ version, ids }) => invoke(() => service.context(version, ids)),
  );

  server.registerTool(
    "tpf_source",
    {
      description:
        "Read at most 200 lines from an approved author-facing TPF source path at one exact released or snapshot version.",
      inputSchema: z.object({
        version: z.string().min(1),
        path: z.string().min(1).max(1_024),
        startLine: z.number().int().positive().default(1),
        endLine: z.number().int().positive().optional(),
      }),
    },
    ({ version, path, startLine, endLine }) =>
      invoke(() => service.source(version, path, startLine, endLine)),
  );

  return server;
}

async function invoke(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(value, undefined, 2) },
      ],
    };
  } catch (error) {
    if (!(error instanceof KnowledgeError)) {
      console.error(
        "TPF knowledge tool failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const knowledgeError =
      error instanceof KnowledgeError
        ? error
        : new KnowledgeError(
            "The TPF knowledge service could not complete the request",
            "INTERNAL",
          );
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            code: knowledgeError.code,
            message: knowledgeError.message,
          }),
        },
      ],
    };
  }
}
