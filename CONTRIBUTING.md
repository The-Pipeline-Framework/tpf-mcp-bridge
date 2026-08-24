# Contributing

Thank you for contributing to the TPF Author Knowledge MCP. This repository owns a public, stateless, read-only Cloudflare Worker and its deterministic knowledge publisher.

## Before opening a change

```shell
npm ci
npm run check
npx wrangler deploy --dry-run --outdir dist/worker
```

Changes to tool behavior, storage, publication, or scope must update the matching tests and operator documentation. Keep every tool bounded, require exact TPF versions, and preserve the author-only allowlist. Maintainer ADRs, `docs/evolve`, backlog material, arbitrary repository paths, sessions, model calls, and write tools are outside the service boundary.

## Repository shape

- `src/` — Worker, MCP tools, bounded service, D1/R2 repository, and publication model;
- `scripts/` — release parity, Repowise input, and immutable knowledge publication tooling;
- `migrations/` — dedicated knowledge-catalogue D1 schema;
- `test/` — unit and Cloudflare Worker integration coverage.

Use pull requests for code changes. Do not deploy production, activate knowledge, change the custom-domain route, or delete retired storage as part of an ordinary contribution.
