# Codex App Server Methods: Core Lifecycle

## Purpose

This is the one-level core-method reference.

It summarizes the core lifecycle method families and points to deep method docs.

## Method Families

## Handshake

- `initialize`
- `initialized` (notification)

Required before any non-handshake call.

## Thread lifecycle

- `thread/start`, `thread/resume`, `thread/fork`
- `thread/list`, `thread/loaded/list`, `thread/read`
- `thread/archive`, `thread/unarchive`, `thread/name/set`
- `thread/compact/start`, `thread/rollback`
- `thread/backgroundTerminals/clean` (experimental)

## Turn lifecycle

- `turn/start`
- `turn/steer`
- `turn/interrupt`

## Review lifecycle

- `review/start`

Supports inline and detached delivery modes with lifecycle markers in stream items.

## Core Behavior Rules

- one active turn per thread at a time
- turn completion/terminal state is signaled by lifecycle notifications
- item completion is authoritative for final item state
- interruption settles only when terminal turn lifecycle is emitted

## Read Next (Level 3)

- Thread/turn deep reference: [`methods-core-threads-and-turns.md`](./methods-core-threads-and-turns.md)
- Review/advanced flow deep reference: [`methods-core-review-and-advanced-thread.md`](./methods-core-review-and-advanced-thread.md)
- Event stream semantics: [`events.md`](./events.md)

## Related docs

- Protocol overview: [`overview.md`](./overview.md)
- Integrations/config methods: [`methods-integrations.md`](./methods-integrations.md)
- Approvals/tool-input flows: [`approvals-and-tool-input.md`](./approvals-and-tool-input.md)
