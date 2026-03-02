# Harness Runtime Event and Lifecycle Contracts

## Purpose

This reference explains how codex-manager layers runtime event dispatch, websocket publishing, transcript upsert behavior, and extension lifecycle controls on top of app-server signals.

## Harness Contract Scope

Harness contracts cover:

- extension runtime event dispatch
- typed handler result envelopes and reconciliation
- websocket lifecycle and transcript delta events
- extension lifecycle list/reload surfaces

These are codex-manager contracts, not native app-server RPC methods.

## Dispatch Model Summary

- fanout dispatch to all subscribed handlers
- deterministic order (`priority`, module name, registration index)
- per-handler timeout isolation
- first-wins action reconciliation per emit pass

## Event Family Summary

- synthesized events (`file_change.approval_requested`, `turn.completed`, `suggest_request.requested`)
- app-server pass-through families:
  - `app_server.<normalized_method>`
  - `app_server.request.<normalized_method>`

## Websocket and Transcript Summary

- queue lifecycle websocket events (`orchestrator_job_*`)
- interactive decision request/resolution events
- raw compatibility websocket events (`notification`, `server_request`)
- transcript delta event (`transcript_updated`)
- transcript upsert route for extension/queue side effects

Pass-through and lifecycle notes:

- app-server pass-through families are emitted for normal user sessions
- pass-through signals are suppressed for purged/deleted and system-owned sessions
- system-owned interactive requests are auto-reconciled by codex-manager and do not surface as normal user pending-decision events

## Extension Lifecycle Summary

- `GET /api/agents/extensions`
- `POST /api/agents/extensions/reload`
- RBAC and trust modes govern mutation access and capability enforcement

## Read next

- Event catalog and normalized signal envelope details: [`harness-runtime-event-catalog.md`](./harness-runtime-event-catalog.md)
- Websocket/transcript/lifecycle endpoint details: [`harness-runtime-websocket-and-transcript.md`](./harness-runtime-websocket-and-transcript.md)
- Extension SDK contracts: [`agent-runtime-sdk.md`](./agent-runtime-sdk.md)

## Related docs

- Operations extension authoring: [`../operations/agent-extension-authoring.md`](../operations/agent-extension-authoring.md)
- Queue framework: [`../operations/agent-queue-framework.md`](../operations/agent-queue-framework.md)
- Implementation snapshot: [`../implementation-status.md`](../implementation-status.md)
