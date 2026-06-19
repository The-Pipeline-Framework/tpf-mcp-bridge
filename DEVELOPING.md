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
- The generator-facing schema authority lives in main TPF `framework/deployment`.
- `template-generator-node/src/pipeline-template-schema.json` is the active generator input schema. It is compiled and enforced with AJV in `template-generator-node/src/pipeline-generator.js`, so refresh it from the built main TPF deployment artifact and run the sync/check pair when scaffold config semantics move:

```bash
npm run sync:pipeline-schema -- ../pipelineframework/framework/deployment/target/classes/META-INF/pipeline/pipeline-template-schema.json
npm run check:pipeline-schema -- ../pipelineframework/framework/deployment/target/classes/META-INF/pipeline/pipeline-template-schema.json
```

- `template-generator-node/src/pipeline-composition-schema.json` is a reference snapshot copied from main TPF `framework/runtime`. It documents the composition sidecar shape for tests; current bridge validation for composition manifests is code-level validation in `assertCompositionManifestInvariants()` in `src/derived-config-validation.ts`.

Both schema snapshots have different validation mechanisms, but both must remain semantically aligned with the main TPF release baseline when scaffold semantics change.
