# Developing TPF MCP Bridge

This file is intentionally developer-facing. Keep the main `README.md` user-facing.

## Install

```bash
npm ci
npm --prefix template-generator-node ci
```

## Test

```bash
npm test
npm --prefix template-generator-node test
```

## Package

```bash
npm pack --dry-run
```

## Run

StdIO bridge:

```bash
npm start
```

Local HTTP helper:

```bash
npm run start:local
```

Cloudflare Worker locally:

```bash
npm run start:worker
```

Deploy Worker:

```bash
npm run deploy:worker
```

## Generator Snapshot

- `template-generator-node/` is a vendored generator snapshot used for scaffold generation.
- the generator-facing schema authority lives in main TPF `framework/deployment`.
- sync the packaged schema after building the main repo:

```bash
npm run sync:pipeline-schema -- ../pipelineframework/framework/deployment/target/classes/META-INF/pipeline/pipeline-template-schema.json
```
