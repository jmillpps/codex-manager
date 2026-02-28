"""Protocol contracts for codex-manager client extension points."""

from __future__ import annotations

from collections.abc import Awaitable, Iterable
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

from .models import StreamEvent

if TYPE_CHECKING:
    from .client import AsyncCodexManager, CodexManager
    from .hooks import RequestCall
    from .stream import StreamContext


@runtime_checkable
class SyncRequestExecutor(Protocol):
    def request(
        self,
        *,
        operation: str,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any: ...


@runtime_checkable
class AsyncRequestExecutor(Protocol):
    async def request(
        self,
        *,
        operation: str,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any: ...


@runtime_checkable
class SyncHeaderProvider(Protocol):
    def headers(self) -> dict[str, str]: ...


@runtime_checkable
class AsyncHeaderProvider(Protocol):
    async def headers(self) -> dict[str, str]: ...


@runtime_checkable
class RetryPolicy(Protocol):
    def should_retry(
        self,
        *,
        attempt: int,
        error: Exception | None,
        status_code: int | None,
    ) -> bool: ...

    def next_delay_seconds(self, *, attempt: int) -> float: ...


@runtime_checkable
class SyncHookMiddleware(Protocol):
    def before(self, call: RequestCall) -> None: ...

    def after(self, call: RequestCall, response: Any) -> None: ...

    def on_error(self, call: RequestCall, error: Exception) -> None: ...


@runtime_checkable
class AsyncHookMiddleware(Protocol):
    async def before(self, call: RequestCall) -> None: ...

    async def after(self, call: RequestCall, response: Any) -> None: ...

    async def on_error(self, call: RequestCall, error: Exception) -> None: ...


@runtime_checkable
class StreamMatcher(Protocol):
    def __call__(self, event: StreamEvent) -> bool: ...


@runtime_checkable
class StreamHandler(Protocol):
    def __call__(self, event: StreamEvent, context: StreamContext) -> Awaitable[None] | None: ...


@runtime_checkable
class StreamRouter(Protocol):
    def add(self, matcher: StreamMatcher, handler: StreamHandler) -> None: ...

    async def dispatch(self, event: StreamEvent, context: StreamContext) -> None: ...


@runtime_checkable
class SyncClientPlugin(Protocol):
    name: str

    def register(self, client: CodexManager) -> None: ...


@runtime_checkable
class AsyncClientPlugin(Protocol):
    name: str

    def register(self, client: AsyncCodexManager) -> None: ...


@runtime_checkable
class PluginLifecycle(Protocol):
    def start(self) -> None: ...

    def stop(self) -> None: ...
