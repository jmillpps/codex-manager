# Protocol Deep Dive: Core Methods for Threads and Turns

## Purpose

Detailed core-method reference for thread and turn lifecycle behavior.

Use with [`methods-core.md`](./methods-core.md) when implementing lifecycle APIs or debugging state transitions.

## Initialization

## `initialize`

Handshake request.

Input highlights:

- `clientInfo` required
- optional `capabilities.experimentalApi`
- optional `capabilities.optOutNotificationMethods`

## `initialized` (notification)

Completes handshake. Required before calling non-handshake methods.

## Thread Methods

## `thread/start`

Creates a new thread and subscribes connection to thread event stream.

Common params include runtime/session defaults (`model`, `cwd`, `approvalPolicy`, `sandbox`, personality).

## `thread/resume`

Reopens existing thread id for continued turns.

## `thread/fork`

Creates new thread by copying history from source thread.

## `thread/list`

Cursor-paginated thread summary list with filters (`archived`, `cwd`, providers, etc.).

## `thread/loaded/list`

Returns in-memory loaded thread ids.

## `thread/read`

Reads thread snapshot; optional `includeTurns` for turn history payload.

## `thread/archive` / `thread/unarchive`

Moves rollout files between active and archive storage views.

## `thread/name/set`

Sets user-facing thread title.

## `thread/compact/start`

Starts manual compaction workflow; compaction progress appears via lifecycle events/items.

## `thread/rollback`

Prunes recent turns from context with persisted rollback semantics.

## `thread/backgroundTerminals/clean` (experimental)

Cleans thread background terminal processes; requires experimental capability.

## Turn Methods

## `turn/start`

Starts one turn for a thread with input items.

Input item types include text/image/localImage/skill/mention variants.

Supports turn-level override fields (model/effort/summary/personality/cwd/sandbox/approval/output schema).

## `turn/steer`

Appends user input to currently active turn (`expectedTurnId` required).

## `turn/interrupt`

Requests turn cancellation; terminal settlement is confirmed via `turn/completed` with interrupted status.

## Related docs

- Core method index: [`methods-core.md`](./methods-core.md)
- Review method deep dive: [`methods-core-review-and-advanced-thread.md`](./methods-core-review-and-advanced-thread.md)
- Event stream semantics: [`events.md`](./events.md)
