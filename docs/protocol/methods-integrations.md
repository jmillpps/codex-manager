# Codex App Server Methods: Integrations and Configuration

## Purpose

This is the one-level integrations-method reference.

It summarizes non-core lifecycle methods and points to deep references.

## Method Families

## Discovery and ecosystem

- `model/list`
- `experimentalFeature/list`
- `collaborationMode/list` (experimental)
- `skills/list`, `skills/config/write`, remote skill under-development variants
- `app/list`
- `mcpServerStatus/list`, `config/mcpServer/reload`, `mcpServer/oauth/login`

## Runtime utility and prompting

- `command/exec`
- `tool/requestUserInput` (experimental)

## Configuration and governance

- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`

## Feedback and account/auth

- `feedback/upload`
- `account/read`
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`

## Behavior Guidance

- discovery surfaces are capability/config dependent and may evolve by runtime version
- requirements/config methods should drive client offer sets for policy-related controls
- account/login flows are event-coupled; clients should listen for completion/update notifications

## Read Next (Level 3)

- Discovery + skills/apps/MCP deep dive: [`methods-integrations-discovery-and-skills.md`](./methods-integrations-discovery-and-skills.md)
- Config/account deep dive: [`methods-integrations-config-and-account.md`](./methods-integrations-config-and-account.md)

## Related docs

- Protocol overview: [`overview.md`](./overview.md)
- Core lifecycle methods: [`methods-core.md`](./methods-core.md)
- Event stream reference: [`events.md`](./events.md)
