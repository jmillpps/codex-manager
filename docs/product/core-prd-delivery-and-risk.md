# Product PRD Deep Dive: Delivery, Metrics, and Risk

## Purpose

This document captures delivery planning semantics for the core product PRD: milestones, success metrics, operational risks, and deferred decisions.

Use it when you need release-readiness context beyond raw requirements.

## Delivery Milestones

## Milestone 1: Core session UX

- chat/session creation and listing
- message send + stream completion flow
- stable transcript rendering and interruption

Exit signals:

- first-turn path works end-to-end on local default setup.
- stream completion and cancel paths are deterministic.

## Milestone 2: Approval and tool-input governance

- in-transcript approval/tool-input rendering
- decision submission and resolution feedback
- websocket + read-path reconciliation for pending/terminal states

Exit signals:

- approval/tool-input decisions are idempotent and recoverable.
- UI does not drift from authoritative runtime state after reconnect windows.

## Milestone 3: Project operations and control-plane maturity

- project/chat movement and lifecycle operations
- session controls and settings workflows
- route parity across web/CLI/API/Python

Exit signals:

- operational workflows are reproducible from CLI and API, not only web UI.
- control/state changes remain stable through session switching and restarts.

## Milestone 4: Extension and queue automation maturity

- deterministic extension dispatch and queue execution model
- worker-session lifecycle reliability
- queue terminal reconciliation and observability

Exit signals:

- background workflows do not block foreground turn experience.
- queue and extension failures are diagnosable via structured status and logs.

## Success Metrics

Core outcome metrics:

- low-latency perceived stream start for typical local prompts.
- high reliability of session resume/transcript continuity after restart.
- deterministic approval/tool-input completion without manual state repair.
- extension reload/trust/RBAC controls validated in test and operational checks.

Engineering quality metrics:

- route parity maintained between API and CLI/Python wrappers.
- contract drift detected by generation/validation gates.
- queue workflows terminalize explicitly with bounded retries.

## Risk Model

## Protocol drift risk

If app-server semantics evolve, mappings may diverge.

Mitigation:

- keep protocol docs split and current.
- maintain coverage gates around route/schema contracts.

## Stream consistency risk

Delta or lifecycle mismatches can produce transcript corruption.

Mitigation:

- favor canonical runtime terminal signals.
- keep reconciliation and idempotent upsert behavior in place.

## Queue stall/latency risk

Background jobs can wedge on worker settlement or stale mappings.

Mitigation:

- bounded timeouts/grace windows
- explicit retry classification
- stale mapping reprovision path

## Governance risk

Extension mutation endpoints and capability enforcement can be misconfigured.

Mitigation:

- RBAC/trust defaults documented and validated
- audit trail for reload attempts
- conformance/release-gate checks required before release

## Deferred Decisions (Intentional)

- multi-tenant identity and enterprise auth model
- distributed/federated orchestration across multiple managers
- richer IDE-like workspace features beyond chat-first scope

Deferred does not mean ignored; it means explicitly out of current product acceptance criteria.

## Release-Readiness Checklist (PRD Perspective)

Before promoting major product changes:

1. requirement-level behavior updated in docs and implementation.
2. architecture and operation docs still match real runtime behavior.
3. validation and conformance gates pass.
4. user workflow impact is reflected in README + one-level docs.

## Related docs

- PRD foundation: [`../prd.md`](../prd.md)
- Requirements deep dive: [`core-prd-requirements.md`](./core-prd-requirements.md)
- Agent platform requirement set: [`agent-platform-requirements.md`](./agent-platform-requirements.md)
- Release gate checklist: [`../operations/release-gate-checklist.md`](../operations/release-gate-checklist.md)
