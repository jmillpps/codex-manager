"""Request hook registry for codex-manager client."""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .protocols import AsyncHookMiddleware, SyncHookMiddleware


@dataclass(slots=True)
class RequestCall:
    operation: str
    method: str
    path: str
    query: dict[str, Any] | None = None
    json_body: Any | None = None
    headers: dict[str, str] | None = None


BeforeHook = Callable[[RequestCall], None | Awaitable[None]]
AfterHook = Callable[[RequestCall, Any], None | Awaitable[None]]
ErrorHook = Callable[[RequestCall, Exception], None | Awaitable[None]]


@dataclass(slots=True)
class HookRegistry:
    _before: dict[str, list[BeforeHook]] = field(default_factory=dict)
    _after: dict[str, list[AfterHook]] = field(default_factory=dict)
    _error: dict[str, list[ErrorHook]] = field(default_factory=dict)

    def add_before(self, operation: str, hook: BeforeHook) -> None:
        self._before.setdefault(operation, []).append(hook)

    def add_after(self, operation: str, hook: AfterHook) -> None:
        self._after.setdefault(operation, []).append(hook)

    def add_error(self, operation: str, hook: ErrorHook) -> None:
        self._error.setdefault(operation, []).append(hook)

    def add_middleware(
        self, operation: str, middleware: SyncHookMiddleware | AsyncHookMiddleware
    ) -> None:
        self.add_before(operation, _require_hook_callable(middleware, "before"))
        self.add_after(operation, _require_hook_callable(middleware, "after"))
        self.add_error(operation, _require_hook_callable(middleware, "on_error"))

    def run_before(self, call: RequestCall) -> None:
        for hook in self._match(self._before, call.operation):
            result = hook(call)
            if inspect.isawaitable(result):
                # Close coroutine objects before rejecting them so sync flows
                # do not leak "coroutine was never awaited" warnings.
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise TypeError("sync clients cannot execute async before hooks")

    def run_after(self, call: RequestCall, response: Any) -> None:
        for hook in self._match(self._after, call.operation):
            result = hook(call, response)
            if inspect.isawaitable(result):
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise TypeError("sync clients cannot execute async after hooks")

    def run_error(self, call: RequestCall, error: Exception) -> None:
        for hook in self._match(self._error, call.operation):
            result = hook(call, error)
            if inspect.isawaitable(result):
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise TypeError("sync clients cannot execute async error hooks")

    async def run_before_async(self, call: RequestCall) -> None:
        for hook in self._match(self._before, call.operation):
            result = hook(call)
            if inspect.isawaitable(result):
                await result

    async def run_after_async(self, call: RequestCall, response: Any) -> None:
        for hook in self._match(self._after, call.operation):
            result = hook(call, response)
            if inspect.isawaitable(result):
                await result

    async def run_error_async(self, call: RequestCall, error: Exception) -> None:
        for hook in self._match(self._error, call.operation):
            result = hook(call, error)
            if inspect.isawaitable(result):
                await result

    @staticmethod
    def _match(registry: dict[str, list[Any]], operation: str) -> list[Any]:
        exact = registry.get(operation, [])
        wildcards = registry.get("*", [])
        return [*wildcards, *exact]


def _require_hook_callable(middleware: object, name: str) -> Callable[..., Any]:
    hook = getattr(middleware, name, None)
    if not callable(hook):
        raise TypeError(f"hook middleware must provide callable {name}()")
    return hook
