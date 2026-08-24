declare namespace Cloudflare {
  interface Env {
    TPF_MCP_KNOWLEDGE: D1Database;
    TPF_MCP_KNOWLEDGE_OBJECTS: R2Bucket;
    TPF_MCP_RATE_LIMITER: RateLimit;
    TPF_MCP_ALLOWED_HOSTS: string;
    TPF_MCP_ALLOWED_ORIGINS: string;
    TPF_MCP_SERVICE_VERSION: string;
  }

  interface Exports {
    default: typeof import("./src/worker.js").default;
  }
}
