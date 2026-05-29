# TPF MCP Bridge

## Project Overview

This repository owns the TPF MCP bridge product:

- local stdio MCP bridge for agent hosts such as Codex, Claude Code, OpenCode, Cursor, and VS Code
- Cloudflare Worker backend for session persistence, scaffold generation, and artifact delivery
- vendored `template-generator-node` snapshot used for scaffold generation

This is a standalone product repo. It is not the main TPF monorepo.

## Core Commands

- Install: `npm ci`
- Install vendored generator deps: `npm --prefix template-generator-node ci`
- Bridge tests: `npm test`
- Vendored generator tests: `npm --prefix template-generator-node test`
- Package dry-run: `npm pack --dry-run`
- StdIO bridge: `npm start`
- Local HTTP helper: `npm run start:local`
- Worker local dev: `npm run start:worker`
- Worker deploy: `npm run deploy:worker`

## Engineering Invariants

- The bridge runs planner execution locally.
- The Worker does hosted session persistence, scaffold generation, and artifact delivery.
- `TPF_LLM_TRANSPORT_MODE=direct-http` is the supported default.
- `mcp-sampling` is experimental and must not be treated as broadly supported.
- Keep `README.md` user-facing and `DEVELOPING.md` maintainer-facing.
- `template-generator-node/` is vendored on purpose. Do not casually rewrite its templates without updating bridge and generator tests together.
- The generator-facing schema authority lives in main TPF `framework/deployment`; sync it with `npm run sync:pipeline-schema` after building the main repo.

## Working Rules

- Prefer `rg` / `rg --files` for search.
- Do not perform destructive git operations unless explicitly requested.
- Keep edits scoped to bridge, Worker, and vendored generator behavior owned here.
- If changing scaffold semantics, update both:
  - `test/service.test.ts`
  - `template-generator-node/__tests__/*`
- If changing package/deploy behavior, update docs and workflow config in the same change.
