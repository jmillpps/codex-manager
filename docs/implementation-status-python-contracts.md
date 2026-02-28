# Implementation Status: Python and Contracts

## Purpose

Detailed status snapshot for Python client and contract-generation surfaces.

Use with [`implementation-status.md`](./implementation-status.md) when validating SDK coverage and typed contract posture.

## Python Client (`packages/python-client`) Status

Implemented core capabilities:

- sync/async clients (`CodexManager`, `AsyncCodexManager`)
- domain wrappers for codex-manager API surfaces
- decorator-based stream/event hooks
- request hook decorators and middleware registration
- protocol-oriented dependency injection boundaries
- deterministic plugin lifecycle support
- generic wait helpers for sync/async workflows

## Remote tool and orchestration support

Implemented:

- dynamic tool-call wrappers (`sessions.tool_calls`, `tool_calls.respond`)
- remote-skill session registry helpers
- catalog preparation/runtime sync helpers
- pending-call drain fallback for websocket delay windows

## Typed model status

Implemented:

- additive typed facade (`cm.typed`, `acm.typed`)
- generated Pydantic models from OpenAPI
- typed validation modes (`typed-only`, `off`, `strict`)
- explicit typed/raw operation coverage declarations

## Contract and generation status

Implemented:

- OpenAPI route/method parity checks (API side)
- OpenAPI schema quality checks for typed-target operations
- Python typed coverage checks
- generated API client and protocol schema outputs in repo

## Validation status

Passing baseline checks:

- TypeScript typecheck/test/build workflows
- runtime smoke and agent conformance gates
- Python compile checks

Environment-limited checks may still be blocked when local Python test dependencies are unavailable.

## Related docs

- Top-level status index: [`implementation-status.md`](./implementation-status.md)
- Python introduction: [`python/introduction.md`](./python/introduction.md)
- Python typed models: [`python/typed-models.md`](./python/typed-models.md)
- Generation/validation runbook: [`operations/generation-and-validation.md`](./operations/generation-and-validation.md)
