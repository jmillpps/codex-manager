# Product Requirements Document

## Purpose

This is the one-level-deeper product foundation for Codex Manager.

It starts where `README.md` leaves off: the README explains what exists; this PRD explains what the product must achieve, what quality bar applies, and what is intentionally out of scope.

Use this as the product source of truth before implementing or reviewing behavior changes.

## Product Definition

## Name

Codex Manager

## One-line summary

A local-first control plane for Codex sessions that provides web/CLI/Python interfaces over one API surface, while keeping `codex app-server` as runtime authority.

## Target users

Primary:

- local operators and developers running Codex-driven workflows.

Secondary:

- extension authors building automation workflows without modifying API core.

## Product Goals

## Core goals

- reliable session/project lifecycle operations.
- stream-correct turn UX with clear completion/failure states.
- safe approval/tool-input/tool-call handling.
- reproducible operations through API, CLI, and Python SDK parity.
- extension-driven queue automation for higher-level workflows.

## Quality goals

- deterministic state transitions under reconnect/restart windows.
- idempotent behavior for repeated user/operator actions.
- operational observability for queue/extension/runtime failures.
- documentation parity with real implementation behavior.

## Non-goals (Current Scope)

- multi-tenant SaaS identity/permissions platform.
- replacing app-server runtime semantics with custom execution engine.
- fully distributed orchestration federation in core product.
- IDE-grade file/project management replacing chat-first workflow.

## Product Experience Baseline

The expected baseline user journey:

1. create/select a chat.
2. send a request and observe progressive stream output.
3. resolve approvals/tool-input prompts when required.
4. inspect summarized thought/tool activity when needed.
5. continue, switch chats, and resume reliably later.

The expected baseline operator journey:

1. validate API health/auth/runtime readiness.
2. operate flows through CLI/API/Python with route parity.
3. inspect queue and extension lifecycle states deterministically.
4. recover from failures through documented runbooks.

## Required Product Surfaces

- Web UI (`apps/web`) for primary transcript and control workflow.
- API control plane (`apps/api`) for lifecycle + runtime bridging.
- CLI (`apps/cli`) for scriptable operational parity.
- Python SDK (`packages/python-client`) for programmable automation.
- Extension runtime (`agents/*` + runtime SDK contracts) for workflow semantics.

## Acceptance Perspective

A product change is complete only when:

1. behavior is implemented and validated.
2. external workflow/API/config impacts are documented in the same change.
3. architecture/operations/protocol docs still match real behavior.
4. release-gate and conformance checks remain green.

## How To Use This PRD

- Start here for scope and decision boundaries.
- Use level-2 PRD docs for full requirements and delivery/risk details.
- Use architecture/implementation docs for “how it works today.”

## Read Next (Level 2)

- Detailed requirements: [`product/core-prd-requirements.md`](./product/core-prd-requirements.md)
- Delivery, metrics, and risk: [`product/core-prd-delivery-and-risk.md`](./product/core-prd-delivery-and-risk.md)
- Agent platform requirement set: [`product/agent-platform-requirements.md`](./product/agent-platform-requirements.md)

## Related implementation docs

- Architecture and invariants: [`architecture.md`](./architecture.md)
- Setup and operations: [`operations/setup-and-run.md`](./operations/setup-and-run.md)
- Protocol index: [`codex-app-server.md`](./codex-app-server.md)
- Current implementation snapshot: [`implementation-status.md`](./implementation-status.md)
