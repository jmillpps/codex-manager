from __future__ import annotations

import asyncio

import pytest

from codex_manager.hooks import HookRegistry, RequestCall


def test_sync_registry_rejects_async_hooks() -> None:
    registry = HookRegistry()

    async def before(_call: RequestCall) -> None:
        return None

    registry.add_before("*", before)
    with pytest.raises(TypeError):
        registry.run_before(RequestCall(operation="x", method="GET", path="/"))


@pytest.mark.asyncio
async def test_async_registry_executes_async_hooks() -> None:
    registry = HookRegistry()
    events: list[str] = []

    async def before(_call: RequestCall) -> None:
        await asyncio.sleep(0)
        events.append("before")

    async def after(_call: RequestCall, _response: object) -> None:
        await asyncio.sleep(0)
        events.append("after")

    registry.add_before("*", before)
    registry.add_after("*", after)

    call = RequestCall(operation="x", method="GET", path="/")
    await registry.run_before_async(call)
    await registry.run_after_async(call, {"ok": True})

    assert events == ["before", "after"]


def test_sync_registry_executes_middleware_in_order() -> None:
    registry = HookRegistry()
    events: list[str] = []

    class Middleware:
        def before(self, _call: RequestCall) -> None:
            events.append("mw.before")

        def after(self, _call: RequestCall, _response: object) -> None:
            events.append("mw.after")

        def on_error(self, _call: RequestCall, _error: Exception) -> None:
            events.append("mw.error")

    registry.add_middleware("*", Middleware())
    call = RequestCall(operation="x", method="GET", path="/")
    registry.run_before(call)
    registry.run_after(call, {"ok": True})

    assert events == ["mw.before", "mw.after"]


@pytest.mark.asyncio
async def test_async_registry_executes_async_middleware() -> None:
    registry = HookRegistry()
    events: list[str] = []

    class Middleware:
        async def before(self, _call: RequestCall) -> None:
            await asyncio.sleep(0)
            events.append("mw.before")

        async def after(self, _call: RequestCall, _response: object) -> None:
            await asyncio.sleep(0)
            events.append("mw.after")

        async def on_error(self, _call: RequestCall, _error: Exception) -> None:
            await asyncio.sleep(0)
            events.append("mw.error")

    registry.add_middleware("*", Middleware())
    call = RequestCall(operation="x", method="GET", path="/")
    await registry.run_before_async(call)
    await registry.run_after_async(call, {"ok": True})

    assert events == ["mw.before", "mw.after"]


def test_sync_registry_rejects_async_middleware() -> None:
    registry = HookRegistry()

    class Middleware:
        async def before(self, _call: RequestCall) -> None:
            return None

        async def after(self, _call: RequestCall, _response: object) -> None:
            return None

        async def on_error(self, _call: RequestCall, _error: Exception) -> None:
            return None

    registry.add_middleware("*", Middleware())
    with pytest.raises(TypeError):
        registry.run_before(RequestCall(operation="x", method="GET", path="/"))
