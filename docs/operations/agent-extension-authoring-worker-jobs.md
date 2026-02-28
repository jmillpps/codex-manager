# Operations Deep Dive: Extension Worker Jobs and Queue Patterns

## Purpose

Detailed extension guidance for queue enqueue behavior and worker job execution patterns.

Use with [`agent-extension-authoring.md`](./agent-extension-authoring.md).

## Queue enqueue fundamentals

Use `enqueueJob` with stable routing ids and deterministic dedupe keys.

Common job type in repository workflows:

- `agent_instruction` with `jobKind` variants

## Dedupe guidance

- use stable keys per source session/turn/item context
- avoid random dedupe fields
- ensure repeated event windows collapse to intended single-flight behavior

## Worker execution model

- system-owned worker sessions are owner+agent scoped
- startup preflight runs orientation and optional bootstrap
- one instruction turn per queued job

## Response mode guidance

`agent_instruction.expectResponse` modes:

- `none`
- `assistant_text`
- `action_intents`

Choose one per workflow contract and keep side effects deterministic.

## Transcript side-effect guidance

- use stable message ids
- keep terminal states explicit (`complete|error|canceled`)
- provide fallback content where terminal reconciliation is required

## Related docs

- Authoring runbook: [`agent-extension-authoring.md`](./agent-extension-authoring.md)
- Queue framework foundation: [`agent-queue-framework.md`](./agent-queue-framework.md)
- Queue payload contracts: [`agent-queue-event-and-job-contracts.md`](./agent-queue-event-and-job-contracts.md)
