# Playbook: Queue Jobs and Suggested Request

## Purpose

Use this playbook when handling queue-backed supervisor work.

Primary API/runtime references:

- `apps/api/src/orchestrator-queue.ts`
- `apps/api/src/orchestrator-processors.ts`
- `apps/api/src/index.ts`
- `agents/supervisor/events.ts`

## Queue Job Types

The API queue executes two job types for supervisor workflows:

- `agent_instruction`
- `suggest_request`

`agent_instruction` payload fields:

- `agent`
- `jobKind`
- `projectId`
- `sourceSessionId`
- `threadId`
- `turnId`
- `instructionText`
- optional `dedupeKey`
- optional `expectResponse` (`none` or `assistant_text`)

`suggest_request` payload fields:

- `requestKey`
- `sessionId`
- `projectId`
- `agent`
- `sourceThreadId`
- `sourceTurnId`
- `instructionText`
- optional `model`
- optional `effort`
- optional `draft`

## Supervisor Job Kinds

Within `agent_instruction`, supervisor handlers use these `jobKind` values:

- `file_change_supervisor_review`
- `turn_supervisor_review`

`suggest_request` queue jobs carry suggest-request instructions directly and return one suggestion string result.

## Core Execution Contracts

For `file_change_supervisor_review` instructions:

- execute in strict order:
  - diff explainability upsert
  - supervisor insight upsert
  - optional auto actions (approve/reject/steer) only if enabled and eligible
- if auto actions are disabled, do not call decision/steer routes
- if user already resolved approval and API returns `404 not_found`, treat as reconciled

For `turn_supervisor_review` instructions:

- upsert one turn-level supervisor review row
- keep synthesis concise and actionable

For `suggest_request` instructions:

- return exactly one concise user-to-agent request text

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

## Queue API Endpoints

- `POST /api/sessions/:sessionId/suggested-request/jobs`
- `POST /api/sessions/:sessionId/suggested-request`
- `GET /api/orchestrator/jobs/:jobId`
- `GET /api/projects/:projectId/orchestrator/jobs`
- `POST /api/orchestrator/jobs/:jobId/cancel`

## Operational Notes

- Suggested request is single-flight per source chat.
- File-change and turn-completed supervisor workflows are triggered by agent events and enqueue `agent_instruction`.
- Transcript visibility is driven by `POST /api/sessions/:sessionId/transcript/upsert` from supervisor job actions, not by queue result payloads.
