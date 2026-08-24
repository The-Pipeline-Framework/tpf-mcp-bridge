import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(here, "migrations"),
          ),
          TPF_MCP_ALLOWED_HOSTS: "localhost",
          TPF_MCP_ALLOWED_ORIGINS: "https://playground.ai.cloudflare.com",
          TPF_MCP_SERVICE_VERSION: "1.0.0",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.worker.test.ts"],
    setupFiles: ["./test/apply-migrations.worker.ts"],
  },
});
