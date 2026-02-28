# Python Typed Models and Facade

## Purpose

Document the current OpenAPI-driven typed model system in `packages/python-client`:

- generated request/response models from `apps/api/openapi/openapi.json`
- additive typed facade on top of existing clients (`cm.typed`, `acm.typed`)
- contract coverage rules so every OpenAPI operation is either typed or explicitly raw

This document describes implementation as it exists now.

## Implemented components

- Generator:
  - `scripts/generate-python-openapi-models.mjs`
- Generated models:
  - `packages/python-client/src/codex_manager/generated/openapi_models.py`
  - `packages/python-client/src/codex_manager/generated/__init__.py`
- Typed facade:
  - `packages/python-client/src/codex_manager/typed/client.py`
  - `packages/python-client/src/codex_manager/typed/contracts.py`
  - `packages/python-client/src/codex_manager/typed/__init__.py`
- Typed validation error:
  - `packages/python-client/src/codex_manager/errors.py` (`TypedModelValidationError`)
- Client integration:
  - `packages/python-client/src/codex_manager/client.py` (`self.typed` on sync+async clients)

## User-facing behavior

### Existing dict API remains unchanged

`CodexManager` and `AsyncCodexManager` domain methods still return dict payloads when called through existing domains (`client.sessions.*`, `client.projects.*`, etc.).

### Typed mode is additive

Use typed facade:

- `cm.typed` on `CodexManager`
- `acm.typed` on `AsyncCodexManager`

Typed methods accept either:

- generated model instances, or
- keyword fields matching request schema aliases

and return generated typed response models (or typed unions when an endpoint has multi-shape success/error payloads).

### Validation modes

Typed boundary behavior is mode-aware:

- `typed-only` (default): typed request/response validation
- `off`: typed facade bypasses parsing and returns raw payloads
- `strict`: typed validation plus dict-domain response validation for strict-target operations

Validation boundaries:

1. typed request boundary (`cm.typed.*`, `acm.typed.*`) before transport
2. typed response boundary (`cm.typed.*`, `acm.typed.*`) after transport
3. strict dict-domain response boundary for strict-target operations (`cm.sessions.*`, `cm.approvals.*`, `cm.tool_input.*`)

Mode configuration:

- constructor argument: `validation_mode="typed-only" | "off" | "strict"`
- environment variable: `CODEX_MANAGER_PY_VALIDATION_MODE=typed-only|off|strict`
- constructor value takes precedence over environment

Per-call override is supported on typed methods:

- `validate=True`
- `validate=False`
- `validate=None` (use client mode)

Per-call override semantics:

- `validate=True`: force typed boundary validation for that call
- `validate=False`: return raw payload for that typed call even when client mode is `typed-only` or `strict`

Strict dict-domain response validation operation keys:

- `sessions.create`
- `sessions.get`
- `sessions.send_message`
- `sessions.settings.get`
- `sessions.settings.set`
- `sessions.settings.unset`
- `sessions.suggest_request`
- `sessions.suggest_request.enqueue`
- `sessions.suggest_request.upsert`
- `approvals.decide`
- `tool_input.decide`

### Current typed operation coverage

Implemented typed wrappers:

- `sessions.create`
- `sessions.get`
- `sessions.send_message`
- `sessions.settings_get`
- `sessions.settings_set`
- `sessions.settings_unset`
- `sessions.suggest_request`
- `sessions.suggest_request_enqueue`
- `sessions.suggest_request_upsert`
- `approvals.decide`
- `tool_input.decide`

OpenAPI operations not yet wrapped with typed domain helpers are explicitly tracked as raw in `typed/contracts.py` (`RAW_OPERATION_IDS`) so operation coverage is complete and auditable.

## Example

```python
from codex_manager import CodexManager
from codex_manager.typed import CreateSessionRequest, SendSessionMessageRequest

with CodexManager.from_profile("local") as cm:
    created = cm.typed.sessions.create(
        CreateSessionRequest(cwd="/workspace", model="gpt-5")
    )

    accepted = cm.typed.sessions.send_message(
        session_id=created.session.session_id,
        payload=SendSessionMessageRequest(text="Summarize recent API changes."),
    )

    print(created.session.title)
    print(accepted.turn_id)
```

## Practical typed workflows

### Handle multi-shape suggest-request responses safely

```python
from codex_manager import CodexManager
from codex_manager.typed import (
    SuggestedRequestBody,
    SuggestedRequestQueuedResponse,
)

with CodexManager.from_profile("local") as cm:
    result = cm.typed.sessions.suggest_request(
        session_id="<session-id>",
        payload=SuggestedRequestBody(draft="Focus on risky changes first."),
    )

    if isinstance(result, SuggestedRequestQueuedResponse):
        print("queued job:", result.job_id)
    else:
        # typed union branch: ok/fallback/no_context/error payloads
        print("status:", result.status)
```

### Use typed settings writes for supervisor/session controls

```python
from codex_manager import CodexManager
from codex_manager.typed import SetSessionSettingsRequest

with CodexManager.from_profile("local") as cm:
    updated = cm.typed.sessions.settings_set(
        session_id="<session-id>",
        payload=SetSessionSettingsRequest(
            scope="session",
            key="supervisor",
            value={
                "fileChange": {
                    "diffExplainability": True,
                    "autoActions": {
                        "approve": {"enabled": False, "threshold": "low"},
                        "reject": {"enabled": False, "threshold": "high"},
                        "steer": {"enabled": False, "threshold": "high"},
                    },
                }
            },
        ),
    )
    print(updated.status)
```

## Error model

Typed parse/validation failures raise:

- `TypedModelValidationError`

Fields:

- `operation`: typed operation key (for example `sessions.create`)
- `boundary`: `request` or `response`
- `model_name`: expected model or union label
- `errors`: structured validation issues
- `status_code`: optional status context when available
- `raw_sample`: trimmed payload sample for diagnostics

Strict-mode dict-domain validation targets are defined in:

- `codex_manager.typed.STRICT_VALIDATION_OPERATION_KEYS`

Typed parse helper:

- `cm.typed.parse(operation_key, payload)`
- `acm.typed.parse(operation_key, payload)`

These parse helpers validate payloads against registered typed contracts and raise `TypedModelValidationError` on mismatch.

Transport/status behavior from existing errors (`ApiError`, `NotFoundError`, etc.) remains unchanged for non-allowed status paths.

Operational fallback:

- set `validation_mode="off"` for immediate compatibility fallback
- optionally re-enable call-by-call typing with `validate=True` on critical typed calls

## Generation workflow

From repo root:

```bash
pnpm openapi:gen
pnpm python:openapi:gen
pnpm python:openapi:check
```

`python:openapi:check` regenerates and asserts no diff for generated files.

## Required quality gates

### API/OpenAPI gates

- `apps/api/src/openapi-route-coverage.test.ts`
  - route/method parity between API registrations and OpenAPI paths
- `apps/api/src/openapi-schema-quality.test.ts`
  - unique/missing `operationId` checks
  - typed-target request/response schema presence and non-loose schema checks

### Python typed coverage gate

- `packages/python-client/tests/unit/test_typed_openapi.py`
  - verifies OpenAPI operation-id set equals declared `ALL_OPENAPI_OPERATION_IDS`
  - verifies `TYPED_OPERATION_IDS` and `RAW_OPERATION_IDS` are disjoint and complete

## OpenAPI requirements for adding new typed operations

Before adding a new typed wrapper:

1. Ensure endpoint has stable `operationId`.
2. Ensure request schema exists and is not a loose `{}` schema.
3. Ensure all expected response statuses expose JSON schemas.
4. Regenerate OpenAPI and generated models.
5. Add/update typed contract mapping and tests.

## Design constraints

- Typed facade must not break or rename existing dict-based domain APIs.
- Generated files are never hand-edited.
- Websocket stream payload typing remains separate from REST OpenAPI response typing.
- `raw.request(...)` remains available as forward-compatibility escape hatch.
