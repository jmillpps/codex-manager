# Queue Runner Deep Dive: Capability Reference

## Purpose

Detailed capability reference for queue-runner execution instructions and side-effect channels.

Use with [`queue-runner.md`](./queue-runner.md).

## Core mutation channels

- transcript upsert (`streaming|complete|error|canceled` states)
- suggested-request upsert (`streaming|complete|error|canceled`)
- approval decision resolution
- tool-input decision resolution
- turn steering submissions

## Context retrieval channels

- session get
- transcript reads
- worker-session context reads
- event stream reads for ordering and state checks

## Reliability rules

- emit deterministic message ids
- parse/validate structured payloads before mutation
- treat conflicts/idempotent states as reconciliation outcomes
- keep terminal states explicit for every workflow path

## Priority model

Queue-runner should prioritize:

1. required terminal-state mutations
2. safety/governance decisions (approval/tool-input)
3. optional advisory output

## Related docs

- Queue runner guide: [`queue-runner.md`](./queue-runner.md)
- Queue framework: [`operations/agent-queue-framework.md`](./operations/agent-queue-framework.md)
- Queue event/job contracts: [`operations/agent-queue-event-and-job-contracts.md`](./operations/agent-queue-event-and-job-contracts.md)
