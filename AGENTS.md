# TPF Author Knowledge MCP

This repository owns the public, read-only MCP service at `mcp.pipelineframework.org`.

## Product boundary

- The Cloudflare Worker is stateless and exposes versioned author knowledge only.
- Repowise is a release-publication input, never a runtime dependency or public API.
- D1 owns the searchable release catalogue. R2 owns immutable page and source payloads.
- Every knowledge lookup requires an exact supported TPF version; never add a latest-version fallback.
- The public catalogue is author-scoped. Do not expose maintainer ADRs, `docs/evolve`, backlog material, or arbitrary repository reads.
- The service does not generate applications, run models, store sessions, execute source, or depend on app-generator.

## Commands

- Install: `npm ci`
- Validate: `npm run check`
- Local Worker: `npm run dev`
- Compile release knowledge: `npm run publish:knowledge -- --framework-dir <clean-tagged-checkout> --version <x.y.z>`
- Publish to staging: add `--environment staging --publish`
- Deploy staging: `npm run deploy:staging`

## Working rules

- Keep tool inputs and responses bounded and evidence-oriented.
- Treat release objects as immutable. A matching checksum is a no-op; a changed checksum for an existing version is an error.
- Update runtime code, D1 migration, publisher, tests, and operator documentation together when the storage contract changes.
- Use a clean external TPF checkout at an exact release tag for publication.
- Never add model credentials or make CI build a Repowise index.
- Do not deploy production or change the custom-domain route without an explicit release action.
