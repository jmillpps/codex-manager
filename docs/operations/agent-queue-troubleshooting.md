# Operations: Agent Queue Troubleshooting

## Purpose

This is the one-level queue troubleshooting guide.

Use it for queue-worker triage, then follow the focused deeper playbooks and contracts.

## Fast triage

1. check queue health and enablement
2. inspect queue job state via API/CLI
3. inspect worker session transcript/logs
4. classify failure as routing, settlement timeout, or capability/policy block

## Primary inspection paths

- `GET /api/health`
- `GET /api/orchestrator/jobs/:jobId`
- `GET /api/projects/:projectId/orchestrator/jobs`
- `POST /api/orchestrator/jobs/:jobId/cancel`

Common artifacts under `.data/`:

- orchestrator job state
- session metadata
- supplemental transcript ledger

## Common failure classes

- stale worker mapping (`thread not found`/invalid thread)
- include-turns materialization grace overflow
- worker turn timeout or empty-progress stall
- missing handler enqueue output or trust/RBAC blocks
- websocket visibility lag (state present but not yet reflected in client)

## Recovery sequence

1. capture health + job payloads
2. retry minimal repro once
3. restart API if stale worker mapping suspected
4. retest and then tune queue/grace settings if needed

## Read Next (Level 3)

- Queue runtime semantics: [`agent-queue-runtime-semantics.md`](./agent-queue-runtime-semantics.md)
- Queue event/job contracts: [`agent-queue-event-and-job-contracts.md`](./agent-queue-event-and-job-contracts.md)
- General troubleshooting index: [`troubleshooting.md`](./troubleshooting.md)

## Related references

- Setup baseline: [`setup-and-run.md`](./setup-and-run.md)
- Queue framework foundation: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Harness runtime events: [`../protocol/harness-runtime-events.md`](../protocol/harness-runtime-events.md)
