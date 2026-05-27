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

## Current Extraction Debt

- `template-generator-node/` is still a vendored snapshot
- canonical schema authority remains deferred to TPF Issue 312
- changes in core TPF config semantics may require coordinated updates here until Issue 312 is closed
