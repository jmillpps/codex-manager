# Implementation Status: API

## Purpose

Detailed API runtime status snapshot for `apps/api`.

Use this with [`implementation-status.md`](./implementation-status.md) when you need API-specific behavior coverage and constraints.

## Runtime Supervision and Transport

- API supervises `codex app-server` over STDIO.
- Performs initialize lifecycle and forwards runtime signals to websocket clients.
- Supports fallback behavior when experimental raw-event support is unavailable.

## Session and Project Lifecycle

Implemented:

- session create/list/get/resume/rename/archive/unarchive/delete
- project create/list/rename/delete
- session <-> project assignment and bulk project chat operations
- session existence gating on mutating control routes

Behavior contracts:

- non-materialized sessions may be visible before first turn materialization
- hard delete is harness-level (app-server has no native `thread/delete`)
- system-owned worker sessions are hidden by default from user session lists

## Messaging and Turn Control

Implemented:

- send message (`turn/start`) with optional per-turn overrides
- interrupt active turn
- thread actions (fork, compact, rollback, review, background terminals clean)
- turn steering endpoint
- send/interrupt/approval-policy and suggest-request routes are system-owned gated (`403`)
- suggest-request run/enqueue routes expose queue/backpressure statuses (`409`, `429`, `503`) in addition to standard session lifecycle statuses

Controls/settings:

- session control tuple persisted and applied (`model`, approval policy, network, sandbox)
- generic per-session/per-default key-value settings APIs
- settings are stored as `controls.settings` and share the same scope model (`session` | `default`)
- control updates preserve existing settings when `controls.settings` is omitted
- settings writes support both single-key (`key/value`) and object (`settings` + `mode=merge|replace`) mutations
- controls/settings writes emit auditable provenance fields (`actor`, `source`) into supplemental transcript history
- default-scope writes enforce lock semantics with `423` when `SESSION_DEFAULTS_LOCKED=true`
- system-owned session access for these routes returns `403`

## Queue and Extension Runtime

Implemented:

- extension module discovery/load from repo + external roots
- deterministic typed event dispatch with timeout isolation
- queue-backed orchestrator jobs with retries/cancel/terminal states
- system-owned agent worker provisioning and startup preflight
- extension lifecycle list/reload endpoints with RBAC/trust enforcement

Repository workflows:

- suggest-request orchestration jobs
- file-change supervisor workflows
- initial default-title rename workflow on new turn start signal

## Approvals, Tool Input, and Dynamic Tool Calls

Implemented:

- pending approval list + decision routes
- pending tool-input list + decision routes
- pending dynamic tool-call list + response routes
- websocket publish for requested/resolved states

## Transcript and Supplemental Ledger

Implemented:

- transcript assembly from canonical thread state + supplemental ledger rows
- transcript upsert API for extension/queue side effects
- websocket `transcript_updated` delta emissions
- terminal-state reconciliation for supervisor/queue supplemental rows

## Health and Observability

Implemented:

- health endpoint includes auth and queue visibility
- websocket stream control contract (`ready`, `ping`/`pong`, subscribe/unsubscribe commands, invalid-command error frames)
- queue lifecycle websocket events (`orchestrator_job_*`)
- raw websocket compatibility envelopes (`notification`, `server_request`) with pass-through app-server event families
- extension reload audit log under `.data/`

## Related docs

- Top-level status index: [`implementation-status.md`](./implementation-status.md)
- API/websocket contracts: [`protocol/harness-runtime-events.md`](./protocol/harness-runtime-events.md)
- Queue framework: [`operations/agent-queue-framework.md`](./operations/agent-queue-framework.md)
- Extension lifecycle controls: [`operations/agent-extension-lifecycle-and-conformance.md`](./operations/agent-extension-lifecycle-and-conformance.md)
