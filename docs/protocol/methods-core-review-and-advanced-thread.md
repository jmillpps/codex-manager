# Protocol Deep Dive: Review and Advanced Core Flows

## Purpose

Detailed reference for review lifecycle and advanced thread semantics.

Use with [`methods-core.md`](./methods-core.md) when implementing review UX, detached review threads, or compaction/rollback behavior.

## Review Method

## `review/start`

Starts reviewer flow for a target and streams review output as turn/item lifecycle events.

Targets include:

- uncommitted changes
- base branch
- specific commit
- custom review instructions

Delivery modes:

- `inline` (same thread)
- `detached` (forked review thread)

Detached mode emits `thread/started` for the review thread before review stream content.

## Review Item Markers

Review lifecycle is reflected with item types:

- `enteredReviewMode`
- `exitedReviewMode`

Final review text is carried in review completion content and should be rendered as plain review output.

## Compaction and Rollback Notes

Compaction and rollback interact with thread history visibility and memory footprint.

- compaction is workflow-driven and event-visible
- rollback affects active context and persisted history semantics

Client guidance:

- rely on canonical read/list methods for post-operation state
- avoid assuming history mutations are instant until lifecycle events/read responses reflect completion

## Advanced Thread Behavior Guidance

- there is no native hard delete method in verified stable core surface
- archive/unarchive and rollback/compact are supported lifecycle controls
- detached review introduces additional thread ids; UIs should preserve source<->review association metadata where needed

## Related docs

- Core method index: [`methods-core.md`](./methods-core.md)
- Thread/turn method deep dive: [`methods-core-threads-and-turns.md`](./methods-core-threads-and-turns.md)
- Event stream reference: [`events.md`](./events.md)
