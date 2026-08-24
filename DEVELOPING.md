# Developing the TPF Author Knowledge MCP

## Architecture

The Worker uses the stateless MCP HTTP handler and creates a fresh MCP server per request. Runtime reads are split deliberately:

- D1 stores supported releases, document metadata, and the FTS5 search index.
- R2 stores immutable normalized page JSON and approved tagged-source files.
- the Worker performs bounded retrieval only; it has no model or Repowise dependency.

The release manifest records the exact TPF tag commit, Repowise version, raw export checksum, bundle checksum, publication time, and object counts. Private Repowise exports are stored separately in R2 under immutable commit-addressed input keys; the Worker cannot serve that input namespace.

## Provisioning

Create dedicated production and staging resources before the first deployment:

```shell
npx wrangler d1 create tpf-mcp-knowledge
npx wrangler d1 create tpf-mcp-knowledge-staging
npx wrangler r2 bucket create tpf-mcp-knowledge
npx wrangler r2 bucket create tpf-mcp-knowledge-staging
```

Replace the placeholder D1 IDs in `wrangler.jsonc` with the IDs returned by Cloudflare. Also replace `REPLACE_WITH_ACCOUNT_SUBDOMAIN` with the actual staging `workers.dev` account subdomain. Keep the existing custom domain on the old Worker until staging has passed the remote smoke.

## Validate

```shell
npm ci
npm run check
npx wrangler deploy --dry-run --outdir dist/worker
```

The test suite covers service limits, exact-version errors, author-scope filtering, deterministic publication, D1/R2 retrieval, and MCP tool calls.

## Automatic Repowise input

TPF's existing Repowise post-commit update remains background and non-blocking. Install the MCP continuation once in one stable, clean `main` checkout per maintainer clone that may prepare knowledge:

```shell
npm run install:repowise-upload-hook -- \
  --framework-dir /path/to/pipelineframework \
  --environment production
```

Git hooks are shared across worktrees in the same clone, so every MCP-managed block first verifies that the event occurred in the exact checkout passed through `--framework-dir`; feature-worktree activity cannot trigger MCP export or delivery. The installer extends the existing post-commit update and adds two bounded hooks. `post-merge` refreshes Repowise for a newly pulled or merged `main`; `post-checkout` retries pending deliveries without re-indexing. After each successful update, the continuation verifies a clean checkout, exact indexed commit, and zero stale pages, then runs the pinned full JSON export.

The export and provenance manifest are written first to the durable local outbox at `.repowise/tpf-mcp-upload-queue/<commit>/`. Cloudflare delivery is a separate retryable step. Only after both immutable R2 objects exist under `inputs/repowise/<commit>/` is the local entry removed. Network or Cloudflare failures leave it queued, retry four times with bounded backoff, and are attempted again by later Git activity. A manual retry, which performs no indexing, is also safe:

```shell
npm run upload:repowise-input -- \
  --framework-dir /path/to/pipelineframework \
  --environment production \
  --retry-only \
  --attempts 4
```

Repeated uploads of the same checksum are no-ops and a different export for an existing commit is rejected. Any authorized maintainer with a healthy index for the exact commit can produce the same immutable input; the release is not bound to one named workstation. Maintainers can authenticate Wrangler with a narrowly scoped Cloudflare API token instead of sharing a personal login.

The hooks contain the absolute path of this TPF Author Knowledge MCP checkout, distinct from the TPF checkout passed through `--framework-dir`. Re-run the installer only if the MCP checkout moves or Repowise's post-commit hook is reinstalled. Update and upload failures are recorded in `.repowise/.update.log` and do not block commits, merges, or checkouts. The outbox is ignored by Git and survives process termination and network loss.

## Compile a release locally

For local or staging validation, publication requires a clean `pipelineframework` checkout whose HEAD is the exact `vX.Y.Z` tag and whose Repowise report is healthy at that commit:

```shell
npm run publish:knowledge -- \
  --framework-dir /path/to/pipelineframework-release \
  --version X.Y.Z \
  --output .publication/X.Y.Z
```

The compiler applies the author-scope allowlist, collects approved tagged source, and writes:

- `manifest.json` with provenance and checksums;
- immutable R2 objects and `uploads.json`;
- `stage.sql` and `activate.sql` for D1.

Generated publication data is local build output and is not committed.

## Publish and deploy

Publish staging knowledge first:

```shell
npm run publish:knowledge -- \
  --framework-dir /path/to/pipelineframework-release \
  --version X.Y.Z \
  --environment staging \
  --publish
```

The staging publisher applies migrations, rejects an existing version with a different checksum, uploads immutable R2 objects, stages D1 data, verifies it, activates the release, and retains the newest three minor lines as supported.

The TPF repository's `.github/workflows/publish.yml` remains the production release authority. After Maven Central and the GitHub release succeed, its final step dispatches `.github/workflows/publish-knowledge.yml` with the exact version, tag, and full release commit. The MCP workflow checks out that tag and waits for up to ten minutes for only the R2 input for the same commit. It then verifies the export checksum, compiles the author-only bundle, publishes it, verifies it, and activates it. There is no per-release MCP preparation command. A missing or mismatched input fails clearly rather than rebuilding with model credentials or substituting stale knowledge. After a delayed queued upload succeeds, rerun only the MCP publication workflow; Maven Central and GitHub release publication are not repeated.

The cross-repository workflow dispatch requires a narrowly scoped GitHub App token or fine-grained token with Actions write access to `The-Pipeline-Framework/tpf-mcp-bridge`; it does not require Contents write. The ordinary `GITHUB_TOKEN` is repository-scoped and cannot perform this dispatch. Repowise and its model credentials never enter GitHub Actions; only the already-compiled candidate crosses the release boundary.

Deploy the Worker through the manual GitHub Actions workflow or `npm run deploy:staging`. Validate `/health` and all four tools with MCP Inspector before production publication and custom-domain cutover.

Production deployment and deletion of retired session/scaffold storage remain explicit operator actions. Do not combine either deletion with the first cutover.
