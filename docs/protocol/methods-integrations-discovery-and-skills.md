# Protocol Deep Dive: Discovery, Skills, Apps, and MCP Methods

## Purpose

Detailed integrations-method reference for discovery and tool ecosystem surfaces.

Use with [`methods-integrations.md`](./methods-integrations.md) when implementing model/skills/apps/MCP controls.

## Discovery Methods

## `model/list`

Lists available models and model capabilities (reasoning effort support, defaults, modality hints, etc.).

## `experimentalFeature/list`

Lists feature flags and lifecycle stages.

## `collaborationMode/list` (experimental)

Lists collaboration presets when available.

## Skills Methods

## `skills/list`

Lists available skills by cwd context with optional forced reload and extra roots.

## `skills/config/write`

Enables/disables a skill by path.

## `skills/remote/read` and `skills/remote/write`

Under-development remote skill endpoints.

## Apps Methods

## `app/list`

Lists accessible apps/connectors with optional thread-context filtering and forced refetch.

Events:

- `app/list/updated` publishes list refresh completion.

Usage note:

- mention payloads (`app://...`) are preferred for deterministic app invocation in turns.

## MCP Methods

## `mcpServerStatus/list`

Lists configured MCP servers and status.

## `config/mcpServer/reload`

Reloads MCP config without full server restart.

## `mcpServer/oauth/login`

Starts OAuth login flow for MCP server; completion reported via notification.

## Related docs

- Integrations method index: [`methods-integrations.md`](./methods-integrations.md)
- Config/account methods deep dive: [`methods-integrations-config-and-account.md`](./methods-integrations-config-and-account.md)
- Event stream reference: [`events.md`](./events.md)
