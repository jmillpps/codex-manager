# Queue Runner CLI Guide

## Purpose

This is the one-level queue-runner guide.

It defines execution posture for worker turns that perform queue side effects through CLI/API surfaces.

## Strict behavior requirements

- do not block foreground user-turn experience
- keep every job path terminal-state explicit
- use idempotent transcript and decision mutation patterns
- parse structured outputs defensively before applying state changes

## Execution model summary

Queue-runner executes worker instructions as single-turn job units and applies side effects via approved mutation routes.

Typical mutation targets:

- transcript rows
- suggested-request state
- approvals/tool-input decisions
- optional steer actions

## Priority guidance

1. complete required terminal-state transitions
2. apply governance decisions deterministically
3. emit optional diagnostics/insight output

## Reliability guidance

- stable ids and deterministic dedupe keys
- bounded retries where retryable
- explicit error terminalization when unrecoverable
- conflict/idempotent outcomes handled as reconciliation, not silent drop

## Read Next

- Capability reference: [`queue-runner-capability-reference.md`](./queue-runner-capability-reference.md)
- Queue framework contracts: [`operations/agent-queue-framework.md`](./operations/agent-queue-framework.md)

## Related docs

- Queue runtime semantics: [`operations/agent-queue-runtime-semantics.md`](./operations/agent-queue-runtime-semantics.md)
- Queue event/job contracts: [`operations/agent-queue-event-and-job-contracts.md`](./operations/agent-queue-event-and-job-contracts.md)
