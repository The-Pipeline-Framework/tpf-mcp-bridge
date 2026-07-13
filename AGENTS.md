# TPF MCP Bridge

## Project Overview

This repository owns the TPF MCP bridge product:

- local stdio MCP bridge for agent hosts such as Codex, Claude Code, OpenCode, Cursor, and VS Code
- Cloudflare Worker backend for session persistence, scaffold generation, and artifact delivery
- pinned `app-generator` dependency used for scaffold generation

This is a standalone product repo. It is not the main TPF monorepo.

## Core Commands

- Install: `npm ci`
- Bridge tests: `npm test`
- Generator tests: run `npm test` in the `app-generator` repository
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
- `app-generator` is pinned deliberately. Update its commit reference and bridge tests together when generator behavior changes.
- The generator-facing schema authority lives in main TPF `framework/deployment`; synchronize it from the `app-generator` repository after building the main repo.

## Working Rules

- Prefer `rg` / `rg --files` for search.
- Do not perform destructive git operations unless explicitly requested.
- Keep edits scoped to bridge, Worker, and generator integration behavior owned here.
- If changing scaffold semantics, update both:
  - `test/service.test.ts`
  - the matching `app-generator/__tests__/*` coverage
- If changing package/deploy behavior, update docs and workflow config in the same change.
