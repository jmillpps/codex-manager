# Python Protocol Interface Examples

## Purpose

Practical examples for protocol-oriented customization of the Python client.

Use with [`protocol-interfaces.md`](./protocol-interfaces.md).

## Custom request executor

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

## Header provider + retry policy

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

cm = CodexManager(header_provider=HeaderProvider(), retry_policy=RetryPolicy())
cm.close()
```

## Middleware registration

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

## Plugin lifecycle

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

## Related docs

- Protocol interface index: [`protocol-interfaces.md`](./protocol-interfaces.md)
- Contract reference: [`protocol-interfaces-contracts.md`](./protocol-interfaces-contracts.md)
