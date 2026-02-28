# Protocol Deep Dive: Primitives and Capabilities

## Purpose

Deep reference for the core runtime primitives and capability model used by app-server clients.

Use with [`overview.md`](./overview.md) to reason about thread/turn/item behavior and feature-surface negotiation.

## Core Primitives

## Thread

Session container for conversation state.

Key lifecycle methods:

- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/list`
- `thread/read`
- archive/unarchive/name/rollback/compact variants

Important note:

- no native `thread/delete` in verified stable method surface; hard delete is harness-level in Codex Manager.

## Turn

Single user->agent exchange within a thread.

Typical signal flow:

- `turn/started`
- `item/started` and optional item delta events
- `item/completed`
- `turn/completed`

Turn-level controls include model/sandbox/approval/effort overrides and interruption/steering paths.

## Item

Atomic payload units in a turn.

Common item families:

- user/agent messages
- reasoning/plan
- command execution
- file changes
- MCP/app tool calls
- review and compaction markers

Authoritative rule:

- treat `item/completed` as final item state.

## Capability-Driven Behavior

Runtime capabilities and configuration requirements shape what clients should expose.

Examples:

- experimental methods gated by `experimentalApi`
- approval/sandbox offer sets constrained by requirements/config surfaces
- model capabilities determine available effort/personality options

Client rule:

- do not hardcode enums where server schema/requirements provide authoritative sets.

## Client-Facing Behavior Requirements

A robust client should:

- maintain continuous event-read loop for active threads
- scope server-initiated requests by `threadId` + `turnId`
- reconcile stream deltas with terminal item/turn notifications
- keep UX state aligned across websocket and read-path recovery windows

## Related docs

- Protocol overview index: [`overview.md`](./overview.md)
- Core method reference: [`methods-core.md`](./methods-core.md)
- Event stream reference: [`events.md`](./events.md)
- Approval/tool-input flows: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)
