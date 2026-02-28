# Development and Packaging

## Package location

- Source: `packages/python-client/src/codex_manager`
- Metadata: `packages/python-client/pyproject.toml`
- Unit tests: `packages/python-client/tests/unit`

## Local development

```bash
pip install -e packages/python-client
python3 -m compileall packages/python-client/src/codex_manager
pnpm python:openapi:gen
```

## Contract expectations

- Domain wrappers should track codex-manager `/api` routes.
- Runtime-only routes should be wrapped explicitly until OpenAPI includes them.
- `raw.request(...)` should remain available as forward-compatibility escape hatch.
- Unit test `test_route_coverage.py` should stay green: it compares server route inventory (`apps/api/openapi/openapi.json` + runtime routes in `apps/api/src/index.ts`) against Python wrapper route calls in `api.py`.

## Design constraints

- Keep transport generic and centralized (`transport.py`).
- Keep endpoint ergonomics in domain classes (`api.py`).
- Keep stream behavior isolated in `stream.py`.
- Keep protocol contracts explicit in `protocols.py`.
- Keep plugin lifecycle orchestration isolated in `plugins.py`.
- Keep protocol injection constructor surface additive and stable (`request_executor`, `header_provider`, `retry_policy`, `hook_registry`, `stream_router`, `plugins`).
- Keep public imports stable in `__init__.py`.
- Use [`protocol-interfaces.md`](./protocol-interfaces.md) as the protocol-architecture contract when expanding transport/hook/plugin interfaces.
- Use [`typed-models.md`](./typed-models.md) for generated typed request/response model architecture, operation coverage, and boundary-validation behavior.
- Keep `pydantic` as a runtime dependency because typed facades are always available (`cm.typed`, `acm.typed`).

## Typed model generation

From repo root:

```bash
pnpm openapi:gen
pnpm python:openapi:gen
pnpm python:openapi:check
```

Rules:

- Never hand-edit `src/codex_manager/generated/openapi_models.py`.
- Update OpenAPI first, then regenerate Python typed models.
- Keep typed contract coverage synchronized in `typed/contracts.py`.

## Protocol validation scope

Protocol boundary tests are expected to cover:

- executor injection (`test_client_protocols.py`)
- header provider and retry policy behavior (`test_client_protocols.py`)
- middleware object semantics (`test_hooks.py`)
- stream router injection and handler isolation (`test_stream_router.py`)
- plugin ordering and lifecycle (`test_plugins.py`)
- typed OpenAPI facade parse/coverage rules (`test_typed_openapi.py`)

## Validation guidance

Before shipping client changes:

1. Run Python compile checks.
2. Run Python unit tests (when pytest is available).
3. Spot-check major workflows against a running codex-manager API.
4. Verify docs match actual method names and paths.

## Related docs

- Python introduction and navigation: [`introduction.md`](./introduction.md)
- API domain wrappers and route map: [`api-surface.md`](./api-surface.md)
- Protocol interface contracts: [`protocol-interfaces.md`](./protocol-interfaces.md)
- Typed model generation/coverage: [`typed-models.md`](./typed-models.md)
