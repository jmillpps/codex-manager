from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from codex_manager import AsyncCodexManager, CodexManager
from codex_manager.errors import TransportError


@dataclass
class _SyncExecutor:
    calls: list[dict[str, Any]] = field(default_factory=list)

    def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return {"ok": True, "attempt": len(self.calls)}


@dataclass
class _AsyncExecutor:
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return {"ok": True, "attempt": len(self.calls)}


def test_sync_executor_injection_uses_protocol_executor() -> None:
    executor = _SyncExecutor()
    client = CodexManager(request_executor=executor)
    try:
        response = client.system.health()
    finally:
        client.close()

    assert response["ok"] is True
    assert executor.calls and executor.calls[0]["operation"] == "system.health"
    assert executor.calls[0]["method"] == "GET"
    assert executor.calls[0]["path"] == "/health"


@pytest.mark.asyncio
async def test_async_executor_injection_uses_protocol_executor() -> None:
    executor = _AsyncExecutor()
    client = AsyncCodexManager(request_executor=executor)
    try:
        response = await client.system.health()
    finally:
        await client.close()

    assert response["ok"] is True
    assert executor.calls and executor.calls[0]["operation"] == "system.health"
    assert executor.calls[0]["method"] == "GET"
    assert executor.calls[0]["path"] == "/health"


def test_header_provider_merges_with_request_headers() -> None:
    executor = _SyncExecutor()

    class HeaderProvider:
        def headers(self) -> dict[str, str]:
            return {"x-provider": "provider", "x-overlap": "provider"}

    client = CodexManager(request_executor=executor, header_provider=HeaderProvider())
    try:
        client.raw.request(
            "GET",
            "/health",
            headers={"x-overlap": "request", "x-request": "request"},
        )
    finally:
        client.close()

    headers = executor.calls[0]["headers"]
    assert headers["x-provider"] == "provider"
    assert headers["x-overlap"] == "request"
    assert headers["x-request"] == "request"


def test_retry_policy_retries_get_requests() -> None:
    class RetryOnceExecutor(_SyncExecutor):
        def request(self, **kwargs: Any) -> Any:
            self.calls.append(dict(kwargs))
            if len(self.calls) == 1:
                raise TransportError("temporary")
            return {"ok": True}

    class RetryPolicy:
        def should_retry(self, *, attempt: int, error: Exception | None, status_code: int | None) -> bool:
            assert error is not None
            assert status_code is None
            return attempt == 1

        def next_delay_seconds(self, *, attempt: int) -> float:
            assert attempt == 1
            return 0.0

    executor = RetryOnceExecutor()
    client = CodexManager(request_executor=executor, retry_policy=RetryPolicy())
    try:
        result = client.system.health()
    finally:
        client.close()

    assert result["ok"] is True
    assert len(executor.calls) == 2


def test_retry_policy_does_not_retry_post_without_opt_in() -> None:
    class AlwaysFailExecutor(_SyncExecutor):
        def request(self, **kwargs: Any) -> Any:
            self.calls.append(dict(kwargs))
            raise TransportError("temporary")

    class RetryPolicy:
        calls = 0

        def should_retry(self, *, attempt: int, error: Exception | None, status_code: int | None) -> bool:
            self.calls += 1
            return True

        def next_delay_seconds(self, *, attempt: int) -> float:
            return 0.0

    executor = AlwaysFailExecutor()
    policy = RetryPolicy()
    client = CodexManager(request_executor=executor, retry_policy=policy)
    try:
        with pytest.raises(TransportError):
            client.raw.request("POST", "/health", operation="custom.post")
    finally:
        client.close()

    assert len(executor.calls) == 1
    assert policy.calls == 0


def test_retry_policy_retries_post_when_operation_opted_in() -> None:
    class RetryOnceExecutor(_SyncExecutor):
        def request(self, **kwargs: Any) -> Any:
            self.calls.append(dict(kwargs))
            if len(self.calls) == 1:
                raise TransportError("temporary")
            return {"ok": True}

    class RetryPolicy:
        def should_retry(self, *, attempt: int, error: Exception | None, status_code: int | None) -> bool:
            return attempt == 1

        def next_delay_seconds(self, *, attempt: int) -> float:
            return 0.0

    executor = RetryOnceExecutor()
    client = CodexManager(
        request_executor=executor,
        retry_policy=RetryPolicy(),
        retryable_operations={"custom.post"},
    )
    try:
        response = client.raw.request("POST", "/health", operation="custom.post")
    finally:
        client.close()

    assert response["ok"] is True
    assert len(executor.calls) == 2
