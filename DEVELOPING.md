# Developing the TPF Author Knowledge MCP

## Architecture

The Worker uses the stateless MCP HTTP handler and creates a fresh MCP server per request. Runtime reads are split deliberately:

- D1 stores supported versions, document metadata, and the FTS5 search index.
- R2 stores immutable normalized page JSON and approved tagged-source files.
- the Worker performs bounded retrieval only; it has no model or Repowise dependency.

The release manifest records the exact TPF tag commit, Repowise version, raw export checksum, bundle checksum, publication time, and object counts. Private Repowise exports are stored separately in R2 under immutable commit-addressed input keys; the Worker cannot serve that input namespace.

Release rows and R2 prefixes are immutable. A snapshot is a public, exact
`X.Y.Z-SNAPSHOT` alias. Its new immutable commit/checksum dataset is fully written before
one final D1 statement switches the alias. The old dataset and R2 bundle are retained, so
a failed refresh cannot corrupt the active snapshot.

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

This automation is **machine-local**. The scripts are versioned here, but Git does not
version or distribute the installed files under the TPF clone's `.git/hooks/` directory.
Cloning either repository on another machine does not install them. Install the
continuation once in one stable, clean `main` checkout per maintainer clone that may
prepare snapshot knowledge. This hook checkout is not the immutable-release checkout:
manual release recovery must use a separate clean checkout at the intended exact
`vX.Y.Z` tag, as described below.

```shell
npm run install:repowise-upload-hook -- \
  --framework-dir /path/to/pipelineframework \
  --environment production
```

The installed hooks embed the absolute paths of both checkouts. On the maintainer machine
they therefore continue to point at the particular MCP checkout from which the installer
was run; moving either checkout breaks that installation until the command is rerun. Use
the following to inspect the effective local installation:

```shell
git -C /path/to/pipelineframework rev-parse --git-path hooks/post-commit
git -C /path/to/pipelineframework rev-parse --git-path hooks/post-merge
git -C /path/to/pipelineframework rev-parse --git-path hooks/post-checkout
```

Git hooks are shared across worktrees in the same clone, so every MCP-managed block first
verifies that the event occurred in the exact checkout passed through `--framework-dir`;
feature-worktree activity cannot trigger MCP export or delivery. The installer extends
Repowise's background post-commit update and adds bounded merge and checkout handling:

- a commit, pull, or merge updates Repowise and then attempts an exact-commit export;
- a checkout retries queued Cloudflare delivery without rebuilding the index;
- all work runs in the background and therefore does not make `git pull` wait;
- output goes to `/path/to/pipelineframework/.repowise/.update.log`.

The hook is convenience automation, not proof of success. Before relying on a prepared
input, verify both commit equality and store health explicitly:

```shell
set -eu
framework_dir=/path/to/pipelineframework
cd "$framework_dir"
test "$(git symbolic-ref --quiet --short HEAD)" = main
expected_commit="$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "$expected_commit"
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(jq -r .last_sync_commit .repowise/state.json)"
repowise doctor --no-workspace
```

The equality check is mandatory. Repowise 0.47 can report all doctor checks healthy even
when `state.json` still names an older commit. The doctor report must additionally show
zero stale pages and synchronized SQL/vector, SQL/FTS, and coordinator counts.

### Known Repowise 0.47 stale-page failure

[Repowise issue #1744](https://github.com/repowise-dev/repowise/issues/1744)
remains reproducible in 0.47: incremental update can leave stale structural file pages
while reporting the repository current. In the observed TPF failure, `doctor --repair`
did nothing and `init --force` retained stale rows. Neither command is an accepted
recovery for publication.

Publication remains fail-closed. A commit mismatch, any stale page, or an inconsistent
SQL/vector/FTS store prevents export and upload; it cannot replace the currently active
MCP snapshot. Inspect `.repowise/.update.log` for the actionable failure.

The proven recovery is a genuinely empty, model-free structural rebuild. For snapshot
recovery, use the installed clean `main` checkout and set `expected_commit` from
`origin/main` as above. For immutable release recovery, use a separate external checkout,
set `version=X.Y.Z`, and establish the intended exact tagged commit before continuing:

```shell
set -eu
framework_dir=/path/to/pipelineframework-release
cd "$framework_dir"
version=X.Y.Z
expected_commit="$(git rev-list -n 1 "v$version")"
test "$(git rev-parse HEAD)" = "$expected_commit"
test "$(git describe --tags --exact-match HEAD)" = "v$version"
test -z "$(git status --porcelain)"
```

Then preserve the old index outside the repository rather than deleting it, retain only
its local configuration, and do not modify `AGENTS.md`. The following common procedure
requires `expected_commit` to have been set by one of the two preparations above:

```shell
set -eu
test -n "${framework_dir:-}"
cd "$framework_dir"
test -n "${expected_commit:-}"
test "$(git rev-parse HEAD)" = "$expected_commit"
test -z "$(git status --porcelain)"
test -d .repowise
test -f .repowise/config.yaml

queue=.repowise/tpf-mcp-upload-queue
if test -d "$queue" && test -n "$(find "$queue" -mindepth 1 -maxdepth 1 -print -quit)"; then
  echo "Refusing recovery while Repowise inputs remain queued" >&2
  exit 1
fi

backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/tpf-repowise-backup.XXXXXX")"
repo_root="$(pwd -P)"
backup_dir="$(cd "$backup_dir" && pwd -P)"
case "$backup_dir/" in
  "$repo_root/"*) echo "Backup directory must be outside the repository" >&2; exit 1 ;;
esac
test ! -e "$backup_dir/index"
mv .repowise "$backup_dir/index"
mkdir -m 700 .repowise
cp "$backup_dir/index/config.yaml" .repowise/config.yaml
if test -f "$backup_dir/index/.env"; then
  cp "$backup_dir/index/.env" .repowise/.env
  chmod 600 .repowise/.env
fi

REPOWISE_SKIP_EDITOR_SETUP=1 repowise init \
  --yes \
  --no-workspace \
  --no-agents \
  --no-codex \
  --no-distill-hook \
  --no-prose \
  --no-seed

test "$(git rev-parse HEAD)" = "$expected_commit"
test "$expected_commit" = "$(jq -r .last_sync_commit .repowise/state.json)"
repowise doctor --no-workspace
```

`--no-prose` makes no LLM calls. The measured TPF recovery on 31 August 2026 generated
4,117 structural pages in 15 minutes 5 seconds with zero model tokens. It still consumes
local CPU, Ollama embedding time, memory, and disk. Keep the backup until the replacement
has passed both validations and uploaded successfully.

After recovery, queue and deliver the exact input explicitly from the installed MCP
checkout:

```shell
set -eu
framework_dir=/path/to/pipelineframework
test -n "${expected_commit:-}"
test "$(git -C "$framework_dir" rev-parse HEAD)" = "$expected_commit"
test "$expected_commit" = "$(jq -r .last_sync_commit "$framework_dir/.repowise/state.json")"
test -z "$(git -C "$framework_dir" status --porcelain)"
repowise doctor --no-workspace "$framework_dir"

cd /path/to/tpf-mcp-bridge
npm run upload:repowise-input -- \
  --framework-dir "$framework_dir" \
  --environment production \
  --attempts 4
```

Automating an isolated candidate index, seeded recovery, and promotion is intentionally
deferred to [issue #53](https://github.com/The-Pipeline-Framework/tpf-mcp-bridge/issues/53)
until its time and maintenance costs are justified.

The export and provenance manifest are written first to the durable local outbox at `.repowise/tpf-mcp-upload-queue/<commit>/`. Cloudflare delivery is a separate retryable step. Only after both immutable R2 objects exist under `inputs/repowise/<commit>/` is the local entry removed. Network or Cloudflare failures leave it queued, retry four times with bounded backoff, and are attempted again by later Git activity. A manual retry, which performs no indexing, is also safe:

```shell
npm run upload:repowise-input -- \
  --framework-dir /path/to/pipelineframework \
  --environment production \
  --retry-only \
  --attempts 4
```

Repeated uploads of the same checksum are no-ops and a different export for an existing commit is rejected. Any authorized maintainer with a healthy index for the exact commit can produce the same immutable input; the release is not bound to one named workstation. Maintainers can authenticate Wrangler with a narrowly scoped Cloudflare API token instead of sharing a personal login.

The hooks contain the absolute path of this TPF Author Knowledge MCP checkout, distinct from the TPF checkout passed through `--framework-dir`. Re-run the installer if either checkout moves or if Repowise's post-commit hook is reinstalled. Update and upload failures are recorded in `.repowise/.update.log` and do not block commits, merges, or checkouts. The outbox is ignored by Git and survives process termination and network loss.

## Compile a release locally

For local or staging validation, publication requires a clean `pipelineframework` checkout whose HEAD is the exact `vX.Y.Z` tag and whose Repowise report is healthy at that commit:

```shell
set -eu
version=X.Y.Z
framework_dir=/path/to/pipelineframework-release
expected_commit="$(git -C "$framework_dir" rev-list -n 1 "v$version")"
test "$(git -C "$framework_dir" rev-parse HEAD)" = "$expected_commit"
test "$(git -C "$framework_dir" describe --tags --exact-match HEAD)" = "v$version"
test -z "$(git -C "$framework_dir" status --porcelain)"

npm run publish:knowledge -- \
  --framework-dir "$framework_dir" \
  --version "$version" \
  --output ".publication/$version"
```

The compiler applies the author-scope allowlist, collects approved tagged source, and writes:

- `manifest.json` with provenance and checksums;
- immutable R2 objects and `uploads.json`;
- `stage.sql` and `activate.sql` for D1.

Generated publication data is local build output and is not committed.

## Publish current main as a snapshot

A snapshot uses a clean source checkout at the exact indexed commit. The Repowise index
may live in a different checkout, which avoids treating Repowise-generated working-tree
metadata as released source:

```shell
npm run publish:knowledge -- \
  --framework-dir /path/to/clean/pipelineframework-main \
  --repowise-index-dir /path/to/indexed/pipelineframework-main \
  --version X.Y.Z-SNAPSHOT \
  --snapshot \
  --environment production \
  --publish
```

The publisher requires the clean checkout's root Maven version and the indexed commit to
match exactly, and requires zero stale Repowise pages. Snapshots cannot use `--stage-only`:
their metadata, FTS rows, and source catalogue are immutable, and only the final public
alias changes. The immutable release path and its support-window calculation are
unaffected.

R2 payloads upload with bounded concurrency through the installed Wrangler executable;
the publisher does not start a separate package-manager process for every object.

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
