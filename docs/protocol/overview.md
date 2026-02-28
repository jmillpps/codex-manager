# Codex App Server Protocol Overview

## Purpose

This is the one-level protocol foundation for Codex Manager.

It explains the core protocol mental model and points to deeper method/event/security references.

## Core Model

`codex app-server` is runtime authority around:

- threads (session containers)
- turns (one exchange)
- items (atomic execution/output units)

Client responsibilities:

1. complete handshake correctly
2. continuously read notifications/server requests
3. render/apply lifecycle state transitions in order
4. answer server-initiated requests exactly once per request id

## Transport and Handshake Summary

- STDIO JSONL is the canonical production transport.
- initialize lifecycle is mandatory before non-handshake methods.
- overload responses are retryable; client backoff should be bounded and jittered.
- experimental method/field usage requires explicit capability opt-in.

## Primitive and Capability Summary

- thread/turn/item lifecycle semantics drive all transcript and action UX.
- `item/completed` is authoritative for final item state.
- requirements/config surfaces constrain what clients should expose (approval/sandbox/etc).

## How This Maps to Codex Manager

Codex Manager API supervises app-server and surfaces:

- REST routes for lifecycle and decisions
- websocket stream events for live state
- harness-level extension/queue behavior layered on runtime signals

Boundary rule: harness logic augments orchestration; it does not redefine app-server runtime truth.

## Read Next (Level 3)

- Transport + handshake deep dive: [`overview-transport-and-handshake.md`](./overview-transport-and-handshake.md)
- Primitive/capability deep dive: [`overview-primitives-and-capabilities.md`](./overview-primitives-and-capabilities.md)
- Core lifecycle methods: [`methods-core.md`](./methods-core.md)
- Integration/config methods: [`methods-integrations.md`](./methods-integrations.md)
- Event stream reference: [`events.md`](./events.md)
- Approval/tool-input flow reference: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)
- Config/security/client rules: [`config-security-and-client-rules.md`](./config-security-and-client-rules.md)

## Related docs

- Protocol index entrypoint: [`../codex-app-server.md`](../codex-app-server.md)
- Harness runtime contracts: [`harness-runtime-events.md`](./harness-runtime-events.md)
