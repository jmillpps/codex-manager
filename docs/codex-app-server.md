# Codex App Server Protocol Guide

## Purpose

This is the one-level-deeper protocol foundation for Codex Manager.

`README.md` explains the product architecture; this guide explains how protocol knowledge is organized and what runtime rules matter most when building against `codex app-server`.

Use this before editing protocol mappings in API/web/CLI/Python surfaces.

## Core Mental Model

`codex app-server` is the runtime authority.

Clients interact with three primary primitives:

- **Thread**: session container
- **Turn**: one user->agent exchange
- **Item**: atomic units inside turns (messages, reasoning, commands, file changes, tool calls)

A robust client/runtime bridge must:

1. complete handshake (`initialize` -> `initialized`) once per connection.
2. keep reading notifications and server-initiated requests continuously.
3. treat terminal item/turn lifecycle notifications as authoritative state.
4. respond exactly once to server-initiated request ids (approvals, tool input, dynamic tool calls).

## How Codex Manager Uses the Protocol

Codex Manager API supervises app-server over STDIO and exposes:

- REST control-plane routes for session/project/actions.
- websocket event fan-out for runtime lifecycle visibility.
- harness-only operational extensions (queue workflows, transcript augmentation, extension dispatch), without replacing app-server runtime truth.

Important boundary:

- harness extensions are additive orchestration around runtime signals; they are not native app-server JSON-RPC methods.

## Last Verified

- Codex Manager API/web integration: February 28, 2026
- Protocol artifacts in repo: `packages/codex-protocol/generated/stable/*`

## Protocol Knowledge Tree (Level 2)

- Transport, framing, handshake, primitives:
  - [`protocol/overview.md`](./protocol/overview.md)
- Core lifecycle methods (`initialize`, `thread/*`, `turn/*`, `review/start`):
  - [`protocol/methods-core.md`](./protocol/methods-core.md)
- Integration and configuration methods (`model/list`, `skills/*`, `app/*`, `mcp*`, `config*`, `account*`, `feedback/*`):
  - [`protocol/methods-integrations.md`](./protocol/methods-integrations.md)
- Event stream catalog and item delta semantics:
  - [`protocol/events.md`](./protocol/events.md)
- Approval and tool-input/dynamic-tool request flows:
  - [`protocol/approvals-and-tool-input.md`](./protocol/approvals-and-tool-input.md)
- Config/security/client hard rules:
  - [`protocol/config-security-and-client-rules.md`](./protocol/config-security-and-client-rules.md)

Harness-layer protocol contracts used by Codex Manager:

- harness runtime event families and websocket envelopes:
  - [`protocol/harness-runtime-events.md`](./protocol/harness-runtime-events.md)
- extension SDK contracts:
  - [`protocol/agent-runtime-sdk.md`](./protocol/agent-runtime-sdk.md)
- extension dispatch/reconciliation semantics:
  - [`protocol/agent-dispatch-and-reconciliation.md`](./protocol/agent-dispatch-and-reconciliation.md)
- extension packaging/compatibility:
  - [`protocol/agent-extension-packaging.md`](./protocol/agent-extension-packaging.md)

## Protocol Deep References (Level 3)

Transport/primitives:

- [`protocol/overview-transport-and-handshake.md`](./protocol/overview-transport-and-handshake.md)
- [`protocol/overview-primitives-and-capabilities.md`](./protocol/overview-primitives-and-capabilities.md)

Core methods:

- [`protocol/methods-core-threads-and-turns.md`](./protocol/methods-core-threads-and-turns.md)
- [`protocol/methods-core-review-and-advanced-thread.md`](./protocol/methods-core-review-and-advanced-thread.md)

Integrations methods:

- [`protocol/methods-integrations-discovery-and-skills.md`](./protocol/methods-integrations-discovery-and-skills.md)
- [`protocol/methods-integrations-config-and-account.md`](./protocol/methods-integrations-config-and-account.md)

Events:

- [`protocol/events-catalog.md`](./protocol/events-catalog.md)
- [`protocol/events-item-types-and-deltas.md`](./protocol/events-item-types-and-deltas.md)

Harness runtime:

- [`protocol/harness-runtime-event-catalog.md`](./protocol/harness-runtime-event-catalog.md)
- [`protocol/harness-runtime-websocket-and-transcript.md`](./protocol/harness-runtime-websocket-and-transcript.md)

## Mapping Protocol to Repository Code

Primary integration points:

- API bridge/supervision: `apps/api/src/index.ts`
- web runtime rendering: `apps/web/src/App.tsx`
- CLI route parity workflows: `apps/cli/src`
- Python SDK route/stream wrappers: `packages/python-client/src/codex_manager`

## Update Rules

When protocol behavior changes in code:

1. update the owning level-2 protocol document.
2. update this index if boundaries/filenames changed.
3. update implementation and operations docs when external behavior/workflow changes.

## Related docs

- Architecture foundation: [`architecture.md`](./architecture.md)
- Setup and runbook: [`operations/setup-and-run.md`](./operations/setup-and-run.md)
- Current implementation snapshot: [`implementation-status.md`](./implementation-status.md)
