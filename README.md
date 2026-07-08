# TPF MCP Bridge

Standalone repo for the TPF MCP bridge product:

- local stdio MCP bridge for Codex, Claude Code, OpenCode, VS Code, Cursor, and similar hosts
- Cloudflare Worker backend for hosted session persistence, scaffold generation, and artifact delivery

## Install

Primary package:

```bash
npx -y @pipelineframework/mcp
```

Installed executable:

```bash
mcp
```

If a host configuration installs or runs the package by name, update it to `@pipelineframework/mcp`.

Local one-shot scaffold generation:

```bash
npx -y @pipelineframework/mcp init --provider codex_cli < brief.md
```

`init` runs entirely on the local machine: it reads the brief, uses the selected planner provider, asks any required contract questions, and writes a generated application directory. `codex_cli` uses the user's authenticated Codex CLI session, so it does not require an OpenAI API key.

Common bridge environment:

```bash
export TPF_LLM_ENDPOINT="https://api.openai.com/v1"
export TPF_LLM_MODEL="gpt-5"
export TPF_LLM_TOKEN="<your-openai-compatible-token>"
export TPF_LLM_PROVIDER_MODE="openai-compatible"
export TPF_LLM_TRANSPORT_MODE="direct-http"
```

What each planner environment variable does:

- `TPF_LLM_ENDPOINT`: base URL for the planner provider API the bridge calls directly
- `TPF_LLM_MODEL`: model identifier sent to that provider
- `TPF_LLM_TOKEN`: bearer token or provider credential used for direct planner calls
- `TPF_LLM_PROVIDER_MODE`: provider protocol to use
  - `openai-compatible` for OpenAI-style `/v1` APIs
  - `ollama-native` for Ollama’s native structured-output path
  - `codex_cli` for the authenticated local Codex CLI (`codex exec`)
  - `opencode` for the authenticated local OpenCode CLI (`opencode run`)
  - `mock` for deterministic local workflow testing with no LLM/provider call
- `TPF_LLM_TRANSPORT_MODE`: how the bridge gets planner completions
  - `direct-http` is the supported default
  - `mcp-sampling` is experimental and only works if the host actually advertises MCP sampling support

Optional planner tuning:

```bash
export TPF_LLM_PROFILE="compact"
```

`full` is the default planner profile. Use `compact` only when you want a smaller, lower-latency prompt profile for weaker or slower local models.

Hosted backend:

```bash
export TPF_MCP_API_BASE_URL="https://mcp.pipelineframework.org/api"
export TPF_MCP_API_TOKEN="<optional-backend-token>"
```

What each backend environment variable does:

- `TPF_MCP_API_BASE_URL`: base URL for the hosted TPF backend used for session storage, scaffold generation, and artifact delivery
- `TPF_MCP_API_TOKEN`: optional bearer token for hosted backend access when the backend is configured to require one

Current product split:

- the bridge always runs locally and owns planner execution
- the Cloudflare backend is the hosted side of the product and provides durable session/artifact capabilities
- if `TPF_MCP_API_BASE_URL` is unset, the bridge still works in local-only mode, but that is a fallback operating mode, not the main product story

Supported planner transports:

- `direct-http` (default, supported)
- `mcp-sampling` (experimental, host-dependent)

Supported provider modes:

- `openai-compatible`
- `ollama-native`
- `codex_cli`
- `opencode`
- `mock`

## Local `init` Command

Examples:

```bash
npx -y @pipelineframework/mcp init --provider codex_cli < brief.md
npx -y @pipelineframework/mcp init --provider opencode --model opencode/openai/gpt-5 < brief.md
TPF_LLM_ENDPOINT=http://localhost:11434 npx -y @pipelineframework/mcp init --provider ollama-native --model qwen3.5:4b < brief.md
npx -y @pipelineframework/mcp init --provider mock < brief.md
```

Useful options:

- `--input <file>` reads the brief from a file instead of stdin.
- `--output <dir>` chooses the generated application directory.
- `--app-name <name>` and `--base-package <package>` override inferred project metadata.
- `--answers <file>` supplies JSON answers for non-interactive runs. If there is exactly one active field question, the file may be a simple field array such as `[{"name":"userId","type":"uuid"}]`.
- `--non-interactive` fails with machine-readable question JSON instead of prompting.

## Exposed MCP Tools

- `inspect_brief`
- `draft_protocol`
- `draft_contracts`
- `resolve_contracts`
- `compile_scaffold_plan`
- `generate_scaffold`

The bridge exposes a small-model-first workflow:

1. inspect the brief
2. draft the protocol and explicit TPF boundaries
3. draft scoped contracts
4. resolve returned questions
5. compile the scaffold plan
6. generate the scaffold once the plan is ready

## Development

Developer-oriented setup, test, packaging, and Worker commands are in [DEVELOPING.md](./DEVELOPING.md).
