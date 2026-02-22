# Operations: Agent Queue Troubleshooting

## Purpose

This runbook covers queue-backed worker issues for system-owned agents (for example supervisor jobs and suggest-request jobs).

Primary question:

- How do I diagnose and recover when queue jobs are stuck, slow, or failing?

## Fast triage

Run these first:

```bash
curl -sS http://127.0.0.1:3001/api/health
```

```bash
tail -n 200 -f .data/logs/codex.log
```

Inspect persisted state:

- `.data/orchestrator-jobs.json`
- `.data/session-metadata.json`
- `.data/supplemental-transcript.json`

## Queue/API inspection endpoints

Single job:

```bash
curl -sS http://127.0.0.1:3001/api/orchestrator/jobs/<jobId>
```

Project jobs:

```bash
curl -sS "http://127.0.0.1:3001/api/projects/<projectId>/orchestrator/jobs"
```

Project jobs by state:

```bash
curl -sS "http://127.0.0.1:3001/api/projects/<projectId>/orchestrator/jobs?state=running"
```

Cancel one job:

```bash
curl -sS -X POST http://127.0.0.1:3001/api/orchestrator/jobs/<jobId>/cancel
```

## Common symptoms and fixes

### Suggest Request stuck in `Suggesting request...`

Checks:

- confirm websocket is connected
- inspect `orchestrator_job_*` events for the pending job id
- query job detail endpoint and check terminal state
- verify source chat is not system-owned and still exists

Likely causes:

- stale mapped worker session
- missing/failed suggest handler enqueue
- queue unavailable

Actions:

1. if queue is disabled, re-enable `ORCHESTRATOR_QUEUE_ENABLED=true` and restart API
2. if job failed with thread/session lookup errors, trigger another request; one-shot mapping recovery should reprovision worker session
3. if still failing, restart API service and retest

### File-change explainability/supervisor insight stays pending

Checks:

- confirm `file_change.approval_requested` event path is enqueueing `agent_instruction`
- inspect job state and error text
- verify transcript upsert rows exist for:
  - `fileChange.explainability`
  - `fileChange.supervisorInsight`
  - `agent.jobOutput`

Likely causes:

- worker turn timeout
- include-turns materialization grace expiry
- websocket disconnect delaying client-side visibility (state present after reload)

Actions:

1. inspect job terminal result via API
2. verify transcript row upserts in `.data/supplemental-transcript.json`
3. if needed, refresh/reload client (delta path may have missed an event)

### Job failed with `thread not found` / invalid thread id

Meaning:

- mapped worker session id is stale or no longer materialized (project-scoped or session-scoped owner mapping)

Behavior:

- `agent_instruction` and `suggest_request` retry classification marks this as retryable
- worker session mapping is cleared and reprovisioned once

Actions:

1. rerun the triggering action once
2. if repeated failures continue, restart API and confirm project metadata integrity in `.data/session-metadata.json`

### Job failed with include-turns materialization error

Typical error:

- `includeTurns not materialized yet for thread ...`

Meaning:

- worker turn/read fallback window exceeded `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`

Actions:

1. confirm current values:
  - `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`
  - `ORCHESTRATOR_AGENT_POLL_INTERVAL_MS`
  - `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS`
2. increase grace modestly if environment is consistently slow to materialize
3. keep timeout and grace aligned so retries happen faster than full-turn timeout burn

### Job failed with `timed out waiting for agent turn completion`

Meaning:

- worker turn did not settle before `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS`

Actions:

1. inspect `agent.jobOutput` transcript row for partial output
2. inspect codex log for backend/runtime stalls
3. tune timeout if workload/model consistently exceeds budget

### Job completed with no assistant output

Meaning:

- instruction turn completed without readable assistant text

Behavior:

- API writes fallback `agent.jobOutput` text:
  - `Agent job completed with no assistant output.`
- supervisor row reconciliation still drives explicit terminal UI states

Actions:

1. inspect worker prompt quality and required action clarity
2. reduce instruction ambiguity and make required API actions explicit

## Configuration knobs

Queue level:

- `ORCHESTRATOR_QUEUE_ENABLED`
- `ORCHESTRATOR_QUEUE_MAX_ATTEMPTS`
- `ORCHESTRATOR_QUEUE_DEFAULT_TIMEOUT_MS`
- `ORCHESTRATOR_QUEUE_MAX_PER_PROJECT`
- `ORCHESTRATOR_QUEUE_MAX_GLOBAL`

Worker turn observation:

- `ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS`
- `ORCHESTRATOR_AGENT_POLL_INTERVAL_MS`
- `ORCHESTRATOR_AGENT_INCLUDE_TURNS_GRACE_MS`

Supervisor policy:

- `SUPERVISOR_AUTO_APPROVE_ENABLED`
- `SUPERVISOR_AUTO_APPROVE_THRESHOLD`
- `SUPERVISOR_AUTO_REJECT_ENABLED`
- `SUPERVISOR_AUTO_REJECT_THRESHOLD`
- `SUPERVISOR_AUTO_STEER_ENABLED`
- `SUPERVISOR_AUTO_STEER_THRESHOLD`

## Recovery sequence

Use this sequence for persistent failures:

1. capture current job and health payloads
2. restart API service
3. retry one minimal workload
4. verify queue event stream and transcript delta behavior
5. only then apply timeout/grace tuning changes

## Related references

- `docs/operations/troubleshooting.md`
- `docs/operations/setup-and-run.md`
- `docs/protocol/harness-runtime-events.md`
- `docs/operations/agent-queue-framework.md`
