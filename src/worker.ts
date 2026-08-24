import { createMcpHandler } from "@modelcontextprotocol/server";

import { createTpfMcpServer } from "./mcp-server.js";
import { D1R2KnowledgeRepository } from "./repository.js";
import { KnowledgeService } from "./service.js";

export interface WorkerEnv {
  TPF_MCP_KNOWLEDGE: D1Database;
  TPF_MCP_KNOWLEDGE_OBJECTS: R2Bucket;
  TPF_MCP_RATE_LIMITER?: RateLimit;
  TPF_MCP_ALLOWED_HOSTS?: string;
  TPF_MCP_ALLOWED_ORIGINS?: string;
  TPF_MCP_SERVICE_VERSION?: string;
}

const DEFAULT_HOSTS = ["mcp.pipelineframework.org", "localhost", "127.0.0.1"];

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const rejected = validateRequestHost(request, env);
    if (rejected !== undefined) {
      return rejected;
    }

    if (request.method === "OPTIONS") {
      return withCors(new Response(undefined, { status: 204 }), request);
    }

    const repository = new D1R2KnowledgeRepository(
      env.TPF_MCP_KNOWLEDGE,
      env.TPF_MCP_KNOWLEDGE_OBJECTS,
    );
    if (url.pathname === "/") {
      return withCors(
        json({
          service: "TPF Author Knowledge MCP",
          endpoint: "https://mcp.pipelineframework.org/mcp",
          documentation: "https://pipelineframework.org",
        }),
        request,
      );
    }
    if (url.pathname === "/health") {
      try {
        const versions = await repository.listVersions();
        return withCors(
          json({
            status: "ok",
            serviceVersion: env.TPF_MCP_SERVICE_VERSION ?? "development",
            activeKnowledgeVersions: versions.map((release) => release.version),
          }),
          request,
        );
      } catch {
        return withCors(json({ status: "unavailable" }, 503), request);
      }
    }
    if (url.pathname !== "/mcp") {
      return withCors(json({ error: "not_found" }, 404), request);
    }
    if (!(await withinRateLimit(request, env))) {
      return withCors(
        json({ error: "rate_limited", retryAfterSeconds: 60 }, 429, {
          "Retry-After": "60",
        }),
        request,
      );
    }

    const service = new KnowledgeService(repository);
    const handler = createMcpHandler(() => createTpfMcpServer(service), {
      legacy: "stateless",
      onerror: (error) => console.error("MCP request failed", error.message),
    });
    return withCors(await handler.fetch(request), request);
  },
} satisfies ExportedHandler<WorkerEnv>;

async function withinRateLimit(
  request: Request,
  env: WorkerEnv,
): Promise<boolean> {
  if (env.TPF_MCP_RATE_LIMITER === undefined) {
    return true;
  }
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const result = await env.TPF_MCP_RATE_LIMITER.limit({
    key: `mcp:${address}`,
  });
  return result.success;
}

function validateRequestHost(
  request: Request,
  env: WorkerEnv,
): Response | undefined {
  const allowed = new Set(
    (env.TPF_MCP_ALLOWED_HOSTS ?? DEFAULT_HOSTS.join(","))
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!allowed.has(hostname)) {
    return json({ error: "invalid_host" }, 403);
  }
  const origin = request.headers.get("Origin");
  if (origin === null) {
    return undefined;
  }
  const allowedOrigins = new Set(
    (env.TPF_MCP_ALLOWED_ORIGINS ?? "https://mcp.pipelineframework.org")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      allowedOrigins.has(parsed.origin)
    ) {
      return undefined;
    }
  } catch {
    // Rejected below.
  }
  return json({ error: "invalid_origin" }, 403);
}

function json(
  value: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function withCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, MCP-Protocol-Version, MCP-Session-Id",
  );
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
