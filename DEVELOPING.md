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

## Release Parity Audit

Run a parity audit before starting scaffold/MCP work for a new TPF release. The audit uses immutable tags from an external `pipelineframework` checkout and classifies release deltas against the scaffold ownership map.

```bash
npm run audit:release-parity -- --framework-dir ../pipelineframework
npm run audit:release-parity -- --from v26.5.2 --to v26.6.1 --framework-dir ../pipelineframework --output reports/tpf-26.6.1-parity.md
```

Required release checklist:

1. Run `npm run check:pipeline-schema -- <pipelineframework>/framework/deployment/src/main/resources/META-INF/pipeline/pipeline-template-schema.json`.
2. Run `npm run audit:release-parity -- --from <previous-tag> --to <target-tag> --framework-dir <pipelineframework>`.
3. Inspect `added file follow-up` separately from changed files; new runtime concepts often enter through new packages, examples, or docs.
4. Inspect open and draft `tpf-mcp-bridge` PRs before implementing parity work. For the 26.6.1 audit, draft PR #20 contains useful Kafka await scaffold wiring that should be ported after PR #21 is the baseline.
5. Choose generated-scaffold compile smokes based on the accepted release surfaces. Schema checks and ZIP assertions are not enough when POMs, runtime config, await transports, or generated Java are involved.
