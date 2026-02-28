# Operations Deep Dive: Web, Stream, and State Troubleshooting

## Purpose

Focused troubleshooting playbook for frontend/websocket state issues.

Use with [`troubleshooting.md`](./troubleshooting.md).

## Web cannot connect

Checks:

- API is reachable
- web dev proxy forwards `/api` and websocket upgrades
- browser network panel shows active `/api/stream`

## Streaming stalls or missing updates

Checks:

- websocket connectivity status in UI/devtools
- API logs for runtime parse/disconnect issues
- runtime process health and restart behavior

## Approval/tool-input rows stuck

Checks:

- active websocket state
- pending decision lists from API/CLI
- session switch/refresh reconciliation behavior

## Transcript scroll/follow regressions

Checks:

- `Jump to bottom` behavior
- follow-mode disengage/re-engage thresholds
- approval transition jitter/snap-back windows

## Session-switch stale hydration

Checks:

- rapid chat switching does not show old pending rows
- delivered user bubbles are not duplicated
- newer websocket decision rows are not dropped by late REST responses

## Related docs

- Troubleshooting index: [`troubleshooting.md`](./troubleshooting.md)
- CLI workflow playbooks: [`cli-workflow-playbooks.md`](./cli-workflow-playbooks.md)
- Queue troubleshooting: [`agent-queue-troubleshooting.md`](./agent-queue-troubleshooting.md)
