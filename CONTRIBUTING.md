# Contributing to TPF MCP Bridge

Thank you for contributing. This repository owns the TPF MCP bridge package, its hosted Worker backend, and the pinned `app-generator` dependency used for scaffold generation.

## Code of Conduct

This project is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Please report unacceptable behavior to [team@pipelineframework.org](mailto:team@pipelineframework.org).

## Before You Start

- For core Java framework, compiler, runtime, or examples work, use the main TPF monorepo instead.
- For bridge, Worker, MCP workflow, hosted artifact flow, or generator integration behavior in this repo, contribute here.

## Development Setup

Prerequisites:

- Node.js 20+
- npm
- Git

Install:

```bash
npm ci
```

## Project Structure

- `src/` - bridge runtime, MCP server, planner integration, Worker backend
- `test/` - bridge and Worker tests
- `app-generator` - pinned standalone generator dependency
- `.github/workflows/` - package publish workflow

## Testing

Run before submitting changes:

```bash
npm test
npm pack --dry-run
```

If your change affects the Worker or packaging flow, also run the relevant local command from [DEVELOPING.md](./DEVELOPING.md).

## Pull Requests

Before submitting:

1. Keep `README.md` user-facing.
2. Put maintainer-only operational notes in `DEVELOPING.md` or `AGENTS.md`.
3. Add or update tests for bridge, Worker, or generator behavior you changed.
4. Update docs when install, env vars, package surface, or hosted-backend behavior changes.
5. Keep the pinned generator dependency and bridge expectations aligned.

## Schema Sync

The standalone `app-generator` repository owns the generator-facing schema snapshot. The schema authority remains in the main TPF repo under `framework/deployment`; when config-shape changes land there, synchronize the snapshot in `app-generator` and then update this bridge's pinned dependency.

```bash
cd ../app-generator && npm run sync:pipeline-schema -- ../pipelineframework/framework/deployment/target/classes/META-INF/pipeline/pipeline-template-schema.json
```
