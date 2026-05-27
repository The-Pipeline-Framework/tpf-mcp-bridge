# Contributing to TPF MCP Bridge

Thank you for contributing. This repository owns the TPF MCP bridge package, its hosted Worker backend, and the vendored `template-generator-node` snapshot used for scaffold generation.

## Code of Conduct

This project is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Please report unacceptable behavior to [team@pipelineframework.org](mailto:team@pipelineframework.org).

## Before You Start

- For core Java framework, compiler, runtime, or examples work, use the main TPF monorepo instead.
- For bridge, Worker, MCP workflow, hosted artifact flow, or vendored generator behavior in this repo, contribute here.

## Development Setup

Prerequisites:

- Node.js 20+
- npm
- Git

Install:

```bash
npm ci
npm --prefix template-generator-node ci
```

## Project Structure

- `src/` - bridge runtime, MCP server, planner integration, Worker backend
- `test/` - bridge and Worker tests
- `template-generator-node/` - vendored generator/schema/templates snapshot
- `.github/workflows/` - package publish workflow

## Testing

Run before submitting changes:

```bash
npm test
npm --prefix template-generator-node test
npm pack --dry-run
```

If your change affects the Worker or packaging flow, also run the relevant local command from [DEVELOPING.md](./DEVELOPING.md).

## Pull Requests

Before submitting:

1. Keep `README.md` user-facing.
2. Put maintainer-only operational notes in `DEVELOPING.md` or `AGENTS.md`.
3. Add or update tests for bridge, Worker, or generator behavior you changed.
4. Update docs when install, env vars, package surface, or hosted-backend behavior changes.
5. Keep the vendored generator snapshot and bridge expectations aligned.

## Deferred Architectural Debt

This repo currently vendors `template-generator-node`. Canonical schema authority is still tracked separately in TPF Issue 312. Until that is resolved, config-shape changes may require coordinated updates between this repo and the main TPF repo.

