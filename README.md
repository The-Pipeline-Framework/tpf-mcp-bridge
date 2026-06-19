# TPF MCP Bridge

Standalone repo for the TPF MCP bridge product:

- local stdio MCP bridge for Codex, Claude Code, OpenCode, VS Code, Cursor, and similar hosts
- Cloudflare Worker backend for hosted session persistence, scaffold generation, and artifact delivery

## Install

Primary package:

```bash
npx -y @pipelineframework/tpf-mcp-bridge
```

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

## Exposed MCP Tools

- `start_brief_session`
- `answer_contract_questions`
- `get_brief_session`
- `generate_scaffold`

The bridge keeps the session workflow intact:

1. start a brief session
2. answer only the returned contract questions
3. generate the scaffold once the session is `ready`

## Development

Developer-oriented setup, test, packaging, and Worker commands are in [DEVELOPING.md](./DEVELOPING.md).
