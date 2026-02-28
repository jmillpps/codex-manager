# Python Deep Dive: Remote Skill Dispatch and Reliability

## Purpose

Detailed reference for tool-call dispatch, response submission, retries, and fallback handling.

Use with [`remote-skills.md`](./remote-skills.md) when you need reliable tool-call completion behavior.

## Signal and Pending-Call Entry Points

Primary realtime path:

- `respond_to_signal(signal)` for `app_server.request.item.tool.call`

Polling fallback path:

- `drain_pending_calls()`
- `respond_to_pending_call(call)`

Both paths execute registered Python handlers and submit responses through codex-manager API.

## Dispatch Outcome Model

`dispatch_tool_call(...)` produces a `RemoteSkillDispatch` record containing:

- `handled`
- normalized `tool`
- `arguments`
- `request_id` and optional `call_id`
- `response_payload`
- optional `error`

Missing skill names produce deterministic failure payloads (`success: false`).

## Response Submission Route

Submission API:

- `POST /api/tool-calls/:requestId/response`

SDK wrapper:

- `client.tool_calls.respond(request_id=..., response=...)`

Submission classification handles server outcomes (`accepted`, retryable, idempotent, terminal error).

## Retry Behavior

Default submission retry behavior:

- `max_submit_attempts=3`
- `retry_delay_seconds=0.05` (linear per-attempt)

You can override both per call:

```python
skills.respond_to_signal(signal, max_submit_attempts=5, retry_delay_seconds=0.1)
```

## Idempotency and Duplicate Protection

The registry tracks locally handled request ids.

Duplicate paths are tagged as idempotent outcomes:

- `local_duplicate`
- server-level `404 not_found` / `409 in_flight` can also be classified idempotently

This prevents repeated side effects when listeners reconnect or receive duplicate work windows.

## Session Guarding

`matches_signal(signal)` and pending-call session extraction prevent cross-session accidental dispatch.

Guideline:

- always use session-scoped `skills = cm.remote_skills.session(session_id)`
- register handler on global stream, but dispatch only through session-scoped `skills` object

## Combined Realtime + Fallback Loop

Reliable pattern:

1. run websocket handler with `respond_to_signal(...)`
2. run periodic fallback task calling `drain_pending_calls()`
3. rely on idempotency classification to avoid duplicate mutations

This handles websocket lag/disconnect windows without overcomplicating end-user code.

## Error Handling Guidance

Treat failures in three classes:

- handler execution failures (bad arguments, runtime exceptions)
- submission transport failures (HTTP exceptions/timeouts)
- terminal server outcomes (malformed request id, policy rejection)

Record `submission_status`, `submission_code`, and `submission_attempts` for diagnostics.

## Related docs

- Remote skills overview: [`remote-skills.md`](./remote-skills.md)
- Lifecycle and catalog controls: [`remote-skills-lifecycle-and-catalog.md`](./remote-skills-lifecycle-and-catalog.md)
- Streaming reliability patterns: [`streaming-reliability-patterns.md`](./streaming-reliability-patterns.md)
