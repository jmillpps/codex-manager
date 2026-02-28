# Playbook: Queue Jobs and Suggested Request

## Purpose

Use this playbook when handling queue-backed supervisor work.

Primary API/runtime references:

- `apps/api/src/orchestrator-queue.ts`
- `apps/api/src/orchestrator-processors.ts`
- `apps/api/src/index.ts`
- `agents/supervisor/events.js`

## Queue Job Types

The API queue executes `agent_instruction` for supervisor workflows.

`agent_instruction` payload fields:

- `agent`
- `jobKind`
- `projectId`
- `sourceSessionId`
- `threadId`
- `turnId`
- optional `bootstrapInstruction` (`key`, `instructionText`) run once per agent session after core system orientation
- `instructionText`
- optional `dedupeKey`
- optional `expectResponse` (`none`, `assistant_text`, or `action_intents`)

## Supervisor Job Kinds

Within `agent_instruction`, supervisor handlers use these `jobKind` values:

- `file_change_supervisor_review`
- `turn_supervisor_review`
- `suggest_request`
- `session_initial_rename`

## Core Execution Contracts

For `file_change_supervisor_review` instructions:

- execute in strict order:
  - diff explainability upsert
  - supervisor insight upsert
  - optional auto actions (approve/reject/steer) only if enabled and eligible
- execute side effects through CLI commands (no raw HTTP and no required JSON response envelope)
- if auto actions are disabled, do not run decision/steer commands
- if user already resolved approval, treat as reconciled

For `turn_supervisor_review` instructions:

- run CLI transcript upserts for streaming + complete review rows
- keep synthesis concise and actionable

For `suggest_request` instructions:

- set streaming state via `sessions suggest-request upsert`
- synthesize one concise user-to-agent request text
- set complete state via `sessions suggest-request upsert --status complete --suggestion...`
- do not rely on assistant-text output as the delivery contract

For `session_initial_rename` instructions:

- inspect session metadata first (`sessions get`)
- rename only when `session.title` is still exactly `New chat`
- generate a concise request-based title and apply via `sessions rename`
- if title is already non-default, stop without side effects

## Queue States and Events

Queue state model:

- `queued`
- `running`
- `completed`
- `failed`
- `canceled`

Websocket events:

- `orchestrator_job_queued`
- `orchestrator_job_started`
- `orchestrator_job_progress`
- `orchestrator_job_completed`
- `orchestrator_job_failed`
- `orchestrator_job_canceled`
- `suggested_request_updated`

## Queue API Endpoints

- `POST /api/sessions/:sessionId/suggested-request/jobs`
- `POST /api/sessions/:sessionId/suggested-request`
- `POST /api/sessions/:sessionId/suggested-request/upsert`
- `GET /api/orchestrator/jobs/:jobId`
- `GET /api/projects/:projectId/orchestrator/jobs`
- `POST /api/orchestrator/jobs/:jobId/cancel`

## Operational Notes

- Suggested request is single-flight per source chat.
- File-change and turn-completed supervisor workflows are triggered by agent events and enqueue `agent_instruction`.
- Transcript visibility is driven by supervisor CLI side effects (`sessions transcript upsert`) as the worker turn runs.
