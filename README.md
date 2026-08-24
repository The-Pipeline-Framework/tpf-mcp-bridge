# TPF Author Knowledge MCP

The hosted MCP at `https://mcp.pipelineframework.org/mcp` gives application-authoring agents bounded, version-exact evidence about The Pipeline Framework.

It complements the TPF authoring skill:

- the skill supplies durable application-architecture guidance;
- this MCP supplies exact documentation, public API, example, and source evidence for the application's pinned TPF release.

The service is public and read-only. It does not scaffold applications, call an LLM, inspect application repositories, or expose TPF maintainer material.

## Tools

| Tool           | Purpose                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `tpf_versions` | List exact releases available to query.                                            |
| `tpf_search`   | Search one exact release, optionally within `docs`, `api`, `examples`, or `skill`. |
| `tpf_context`  | Retrieve up to five complete search results.                                       |
| `tpf_source`   | Read up to 200 lines from an approved source path.                                 |

Every knowledge request requires an exact version. The MCP never substitutes a newer patch, another minor line, or `latest`.

## Connect

Clients with remote Streamable HTTP support connect directly to:

```text
https://mcp.pipelineframework.org/mcp
```

For example, Codex CLI can register it with:

```shell
codex mcp add tpf --url https://mcp.pipelineframework.org/mcp
```

## Develop

```shell
npm ci
npm run check
npm run dev
```

See [DEVELOPING.md](DEVELOPING.md) for release compilation, storage, validation, and deployment details.
