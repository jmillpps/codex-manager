# Codex App Server Configuration, Security, and Client Rules

## MCP configuration surface (what Codex understands)

Codex supports MCP servers to provide tools and context.

Codex supports:

- STDIO MCP servers (local process launchers)
- Streamable HTTP MCP servers (remote addressable servers with bearer token or OAuth)

MCP server configuration is stored in `config.toml`:

- User scope: `~/.codex/config.toml`
- Project scope: `.codex/config.toml` (trusted projects only)

### MCP server configuration keys

Each server is configured under:

- `[mcp_servers.<server-name>]`

STDIO server keys:

- `command` (required)
- `args` (optional)
- `env` (optional)
- `env_vars` (optional allow/forward list)
- `cwd` (optional)

Streamable HTTP server keys:

- `url` (required)
- `bearer_token_env_var` (optional)
- `http_headers` (optional)
- `env_http_headers` (optional)

Common keys:

- `startup_timeout_sec` (optional; default 10)
- `startup_timeout_ms` (alias)
- `tool_timeout_sec` (optional; default 60)
- `enabled` (optional)
- `required` (optional; fail startup if enabled server cannot initialize)
- `enabled_tools` (allow list)
- `disabled_tools` (deny list; applied after allow list)

OAuth support settings:

- `mcp_oauth_callback_port` (optional fixed local callback port; otherwise ephemeral)
- `mcp_oauth_credentials_store` (`auto | file | keyring`)

### MCP constraints via requirements

Admin-enforced requirements can constrain MCP:

- allowlists can require both the server name and identity to match for enabling
- identity fields include:
  - `mcp_servers.<id>.identity.command`
  - `mcp_servers.<id>.identity.url`

## Security and permissions surface (what the server may require from the user)

Codex uses two layers of safety control:

- Sandbox mode/policy: what actions are technically permitted (filesystem + network)
- Approval policy: when the user must explicitly approve actions

### Sandbox policies (turn-level)

Sandbox policy is carried as `sandboxPolicy` in `turn/start` (and `command/exec`), with a `type` such as:

- `readOnly`
- `workspaceWrite`
- `dangerFullAccess`
- `externalSandbox`

Network access semantics differ:

- `externalSandbox`: `networkAccess` is `"restricted" | "enabled"`
- otherwise: `networkAccess` is typically boolean

### Approval policy

Approval policies are string enums; exact allowed values are schema-defined and may be constrained by `configRequirements/read`.

Clients MUST use:

- `configRequirements/read` allow lists (when present)
- plus the app-server schema enums

to decide what approval policies to offer in UI.

## UI surface checklist (what a rich client must be able to render)

A client that fully supports the app-server surface MUST be able to:

- Create, resume, fork, list, read, archive/unarchive threads.
- Render a thread transcript using items:
  - user messages, agent messages
  - plan and plan updates
  - reasoning summaries (when present)
  - diffs and file change summaries
  - command executions with live output
  - MCP tool calls and their results/errors
  - review markers and review text
  - compaction markers
- Stream agent responses via `item/agentMessage/delta`.
- Render progress and completion states using `item/started` + `item/completed`.
- Render turn-level plan/diff updates (`turn/plan/updated`, `turn/diff/updated`) while still treating items as authoritative.
- Handle server-initiated requests:
  - command approvals
  - file change approvals
  - dynamic tool calls (if experimental is enabled)
  - user prompts (`tool/requestUserInput`) when invoked
- Provide authentication flows:
  - API key
  - ChatGPT browser login
  - logout
  - rate limit display
- Provide MCP management visibility:
  - list MCP servers + status (`mcpServerStatus/list`)
  - initiate OAuth login (`mcpServer/oauth/login`) and react to completion notifications
- Provide settings/config surfaces:
  - read effective config (`config/read`)
  - write config (`config/value/write`, `config/batchWrite`)
  - read requirements constraints (`configRequirements/read`)
- Handle errors robustly:
  - `error` notifications mid-turn
  - failed turns at `turn/completed`
  - overload errors (`-32001`) with retry behavior
- Support opt-out notification lists for performance-sensitive UIs.

## Non-negotiable client rules

- Never send any method before completing initialize/initialized handshake.
- Always keep reading the event stream once a thread is active.
- Always treat `item/completed` as authoritative.
- Always scope approvals and tool calls by `threadId` + `turnId`.
- Never assume experimental methods or fields exist unless `experimentalApi` is enabled.
- Never assume enum values; use generated schema + `configRequirements/read`.

## Related docs

- Protocol overview and handshake: [`overview.md`](./overview.md)
- Core lifecycle methods: [`methods-core.md`](./methods-core.md)
- Integration/configuration methods: [`methods-integrations.md`](./methods-integrations.md)
- Event stream reference: [`events.md`](./events.md)
- Approvals and tool-input flows: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)
