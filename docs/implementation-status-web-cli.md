# Implementation Status: Web and CLI

## Purpose

Detailed status snapshot for `apps/web` and `apps/cli`.

Use with [`implementation-status.md`](./implementation-status.md) for current interaction and operator-surface behavior.

## Web (`apps/web`) Status

## Core UX implemented

- split-pane chat workspace with project/chat navigation
- consolidated turn rendering (user request + unified response card)
- markdown-rendered assistant output
- progressive thought/disclosure UI with grouped activity context

## Runtime interaction implemented

- websocket-backed stream lifecycle rendering
- reconnect overlay and reconnect-aware recovery patterns
- outgoing delivery-state indicators and incoming receive-state indicators
- completion state marker for finalized assistant replies

## Approval/tool-input/tool-call UI

- inline approval cards with decision actions
- tool-input request visibility and resolution surfaces
- dynamic tool-call visibility tied to runtime events
- stale-hydration race guards on session switching

## Session controls implemented

- scope-aware apply/revert workflow for control tuple
- lock-aware default scope presentation
- supervisor settings surfaced in session controls
- per-chat thinking-level selector with tooltip support

## Suggested request and explainability surfaces

- queue-backed suggest-request interaction with single-flight guarding
- explainability/supervisor transcript type rendering for diff-centric workflows

## CLI (`apps/cli`) Status

## Surface coverage implemented

- route-complete command grouping for API domains
- profile-based runtime/auth defaults
- websocket stream event command
- raw request fallback command

## Operational workflows implemented

- session/project lifecycle operations
- approval/tool-input/tool-call decision operations
- queue/orchestrator job visibility and waiting/cancel paths
- extension lifecycle inventory/reload commands

## Quality guardrails

- CLI route-parity checks against API route inventory
- JSON output mode for machine automation

## Related docs

- Top-level status index: [`implementation-status.md`](./implementation-status.md)
- Web/API behavior details: [`operations/troubleshooting.md`](./operations/troubleshooting.md)
- CLI runbook: [`operations/cli.md`](./operations/cli.md)
- Setup/run baseline: [`operations/setup-and-run.md`](./operations/setup-and-run.md)
