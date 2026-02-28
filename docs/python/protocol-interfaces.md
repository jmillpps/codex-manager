# Python Protocol Interfaces

## Purpose

Document the implemented protocol-oriented architecture for the codex-manager Python client so transport, request execution, hooks, stream routing, auth/header providers, and plugins are swappable without changing the public domain API.

This file describes implementation as it exists now.

Completed implementation:

- protocol contracts in `packages/python-client/src/codex_manager/protocols.py`
- deterministic plugin registry in `packages/python-client/src/codex_manager/plugins.py`
- constructor-level dependency injection in `packages/python-client/src/codex_manager/client.py`
- middleware object registration in `packages/python-client/src/codex_manager/hooks.py`
- injectable stream router boundary in `packages/python-client/src/codex_manager/stream.py`
- request executor protocol compatibility in `packages/python-client/src/codex_manager/transport.py`
- focused unit tests for protocol boundaries under `packages/python-client/tests/unit/`

## Compatibility Invariants

1. Keep `CodexManager` and `AsyncCodexManager` names unchanged.
2. Keep domain attributes unchanged (`system`, `sessions`, `projects`, `approvals`, `tool_input`, etc.).
3. Keep endpoint wrapper names and payload conventions unchanged unless explicitly versioned.
4. Keep stream decorators unchanged:
   - `on_event`
   - `on_event_prefix`
   - `on_app_server`
   - `on_app_server_request`
   - `on_turn_started`
5. Keep `raw.request(...)` available.
6. Keep settings namespace behavior unchanged (`session(...).settings.namespace(...)`).

## Protocol Contracts

Implemented contracts live in `protocols.py`:

- request execution:
  - `SyncRequestExecutor`
  - `AsyncRequestExecutor`
- header providers:
  - `SyncHeaderProvider`
  - `AsyncHeaderProvider`
- retry policy:
  - `RetryPolicy`
- hook middleware:
  - `SyncHookMiddleware`
  - `AsyncHookMiddleware`
- stream routing:
  - `StreamMatcher`
  - `StreamHandler`
  - `StreamRouter`
- plugin model:
  - `SyncClientPlugin`
  - `AsyncClientPlugin`
  - `PluginLifecycle`

## Client Injection Surface

The following optional constructor arguments are now available on both clients where applicable:

- request execution: `request_executor`
- dynamic headers: `header_provider`
- retry behavior: `retry_policy`, `retryable_operations`
- hook registry override: `hook_registry`
- stream routing override: `stream_router`
- plugin registration: `plugins`

Hook middleware object registration is exposed via:

- `CodexManager.use_middleware(...)`
- `AsyncCodexManager.use_middleware(...)`

## Runtime Semantics

### Hook semantics

- `before` runs before request execution.
- `after` runs after successful response.
- `on_error` runs on terminal failure.
- sync path rejects awaitables and closes coroutine objects before raising.
- middleware execution order remains deterministic by registration order.

### Retry semantics

- retries are disabled unless `retry_policy` is provided.
- read-safe methods (`GET`, `HEAD`, `OPTIONS`) are retry-eligible by default.
- mutating operations are retry-ineligible by default and must be explicitly opted in via `retryable_operations`.

### Stream semantics

- reconnect uses bounded exponential backoff.
- periodic ping keeps idle stream connections alive.
- malformed stream payloads are ignored without killing the loop.
- handler exceptions remain isolated and logged (default router).
- router boundary is swappable via `stream_router`.

### Plugin semantics

- registration order is deterministic.
- registration failures fail fast.
- lifecycle `start()` runs in registration order.
- lifecycle `stop()` runs in reverse order.

## Security and Safety Requirements

1. No implicit remote plugin loading.
2. Plugin loading is explicit by caller code only.
3. Header providers must not leak secrets in logs.
4. Retry defaults must not replay mutating actions silently.

## Observability Requirements

- handler failures remain log-visible in stream execution.
- retry decision hooks remain externally testable.
- middleware ordering remains testable.

## Implementation Map

- `protocols.py`: typed extension-point contracts.
- `transport.py`: protocol-compatible request signature for sync/async transports.
- `client.py`: dependency injection, retry/header provider orchestration, plugin wiring.
- `hooks.py`: middleware object registration support.
- `stream.py`: router protocol boundary and injectable router wiring.
- `plugins.py`: deterministic registration + lifecycle orchestration.

## Usage Examples

### Inject a custom executor

```python
from codex_manager import CodexManager

class RecordingExecutor:
    def request(self, **kwargs):
        print(kwargs["operation"], kwargs["method"], kwargs["path"])
        return {"ok": True}

cm = CodexManager(request_executor=RecordingExecutor())
print(cm.system.health())
cm.close()
```

### Add dynamic headers and conservative retries

```python
from codex_manager import CodexManager

class HeaderProvider:
    def headers(self):
        return {"x-codex-rbac-token": "token"}

class RetryPolicy:
    def should_retry(self, *, attempt, error, status_code):
        return attempt < 3

    def next_delay_seconds(self, *, attempt):
        return 0.25 * attempt

cm = CodexManager(
    header_provider=HeaderProvider(),
    retry_policy=RetryPolicy(),
    retryable_operations={"projects.create"},
)
cm.close()
```

### Register middleware objects

```python
from codex_manager import CodexManager

class AuditMiddleware:
    def before(self, call):
        print("before", call.operation)

    def after(self, call, response):
        print("after", call.operation)

    def on_error(self, call, error):
        print("error", call.operation, error)

cm = CodexManager()
cm.use_middleware(AuditMiddleware())
cm.close()
```

### Register plugins with lifecycle hooks

```python
from codex_manager import CodexManager

class MetricsPlugin:
    name = "metrics"

    def register(self, client):
        self.client = client

    def start(self):
        print("metrics started")

    def stop(self):
        print("metrics stopped")

cm = CodexManager(plugins=[MetricsPlugin()])
cm.close()
```

## Validation Gate

Expected gate:

1. `python3 -m compileall packages/python-client/src/codex_manager`
2. `python3 -m compileall packages/python-client/tests/unit`
3. route parity check in `test_route_coverage.py`
4. protocol-focused tests for executor injection, middleware behavior, stream router behavior, and plugin lifecycle

Current environment note:

- `pytest` execution is blocked when `pip`/`pytest` are unavailable locally.
- compile and route-parity checks still run and should remain part of every change.

## Maintenance rules

1. Keep constructor injection surface additive and backward-compatible.
2. Keep protocol boundary tests green when extending interfaces.
3. Keep this document aligned with shipped implementation details.
