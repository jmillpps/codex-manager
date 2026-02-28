# Protocol Deep Dive: Item Types and Delta Semantics

## Purpose

Detailed event semantics for turn/item lifecycle, item families, and delta behavior.

Use with [`events.md`](./events.md) when implementing transcript rendering and live updates.

## Turn Lifecycle Events

- `turn/started` with in-progress turn context
- `turn/completed` with terminal state (`completed|interrupted|failed`)
- optional in-turn updates:
  - `turn/diff/updated`
  - `turn/plan/updated`
  - `thread/tokenUsage/updated`

## Item Lifecycle Events

All item families follow:

- `item/started`
- optional item-specific deltas
- `item/completed` (authoritative final state)

## Common Item Families

- `userMessage`
- `agentMessage`
- `plan`
- `reasoning`
- `commandExecution`
- `fileChange`
- `mcpToolCall`
- collaboration/review/compaction/web-search/image-view markers

## Delta Event Semantics

## Agent text

- `item/agentMessage/delta`

Append deltas in-order; reconcile with terminal completed item.

## Plan deltas

- `item/plan/delta` (experimental usage patterns possible)

## Reasoning deltas

- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`

## Command and file deltas

- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`

## Error Signaling

- `error` notification may precede failed `turn/completed`
- failed turns carry structured error fields (`message`, optional provider-specific diagnostics)

Client guidance:

- show real-time error context but finalize on terminal lifecycle state.

## Related docs

- Event stream index: [`events.md`](./events.md)
- Method catalog: [`events-catalog.md`](./events-catalog.md)
- Core lifecycle methods: [`methods-core.md`](./methods-core.md)
