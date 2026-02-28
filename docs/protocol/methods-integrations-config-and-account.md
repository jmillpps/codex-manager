# Protocol Deep Dive: Config, Runtime Utility, and Account Methods

## Purpose

Detailed integrations-method reference for config writes, runtime utility methods, feedback, and account/auth flows.

Use with [`methods-integrations.md`](./methods-integrations.md) for implementation details on non-thread lifecycle operations.

## Runtime Utility

## `command/exec`

Executes one command without thread/turn lifecycle context.

Supports `cwd`, sandbox policy, and timeout controls.

## `tool/requestUserInput` (experimental)

Server-initiated prompting surface for tools that need structured user input.

## Configuration Methods

## `config/read`

Reads effective merged configuration.

## `config/value/write`

Writes one config key/value.

## `config/batchWrite`

Applies multiple config edits atomically.

## `configRequirements/read`

Reads requirements constraints (approval/sandbox and related policy constraints).

## Feedback Method

## `feedback/upload`

Submits feedback report payload and returns tracking context.

## Account/Auth Methods

## `account/read`

Reads current auth state and provider requirements.

## `account/login/start`

Starts login flow (`apiKey` or `chatgpt` mode).

## `account/login/cancel`

Cancels in-progress chatgpt login flow.

## `account/logout`

Clears auth state.

## `account/rateLimits/read`

Reads account-related rate-limit information.

Associated notifications include login/account/rate-limit updates.

## Related docs

- Integrations method index: [`methods-integrations.md`](./methods-integrations.md)
- Discovery/skills/apps/MCP deep dive: [`methods-integrations-discovery-and-skills.md`](./methods-integrations-discovery-and-skills.md)
- Event stream reference: [`events.md`](./events.md)
- Config/security client rules: [`config-security-and-client-rules.md`](./config-security-and-client-rules.md)
