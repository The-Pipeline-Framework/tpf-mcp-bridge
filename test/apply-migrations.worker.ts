import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.TPF_MCP_KNOWLEDGE, env.TEST_MIGRATIONS);
