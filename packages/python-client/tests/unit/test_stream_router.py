from __future__ import annotations

import pytest

from codex_manager.models import StreamEvent
from codex_manager.stream import AsyncEventStream, EventRouter, StreamContext


@pytest.mark.asyncio
async def test_event_router_isolates_handler_failures() -> None:
    seen: list[str] = []

    async def on_error(error: Exception, _event: StreamEvent) -> None:
        seen.append(f"error:{type(error).__name__}")

    router = EventRouter(on_handler_error=on_error)

    async def broken(_event: StreamEvent, _context: StreamContext) -> None:
        raise RuntimeError("boom")

    async def healthy(_event: StreamEvent, _context: StreamContext) -> None:
        seen.append("healthy")

    router.add(lambda _event: True, broken)
    router.add(lambda _event: True, healthy)

    await router.dispatch(
        StreamEvent(type="x", thread_id=None, payload={}),
        StreamContext(thread_id=None, reconnect_count=0),
    )

    assert seen == ["error:RuntimeError", "healthy"]


@pytest.mark.asyncio
async def test_event_router_isolates_matcher_failures() -> None:
    seen: list[str] = []

    async def on_error(error: Exception, _event: StreamEvent) -> None:
        seen.append(f"error:{type(error).__name__}")

    router = EventRouter(on_handler_error=on_error)

    async def healthy(_event: StreamEvent, _context: StreamContext) -> None:
        seen.append("healthy")

    def broken_matcher(_event: StreamEvent) -> bool:
        raise RuntimeError("matcher boom")

    router.add(broken_matcher, healthy)
    router.add(lambda _event: True, healthy)

    await router.dispatch(
        StreamEvent(type="x", thread_id=None, payload={}),
        StreamContext(thread_id=None, reconnect_count=0),
    )

    assert seen == ["error:RuntimeError", "healthy"]


@pytest.mark.asyncio
async def test_async_stream_accepts_injected_router() -> None:
    class RecordingRouter:
        def __init__(self) -> None:
            self.routes = []
            self.dispatched = []

        def add(self, matcher, handler) -> None:
            self.routes.append((matcher, handler))

        async def dispatch(self, event: StreamEvent, context: StreamContext) -> None:
            self.dispatched.append((event, context))

    router = RecordingRouter()
    stream = AsyncEventStream(base_url="http://127.0.0.1:3001", api_prefix="/api", router=router)

    @stream.on_event("custom.event")
    async def _handler(_event: StreamEvent, _context: StreamContext) -> None:
        return None

    assert len(router.routes) == 1
    matcher, _handler = router.routes[0]
    assert matcher(StreamEvent(type="custom.event", thread_id=None, payload={})) is True

    event = StreamEvent(type="custom.event", thread_id="t1", payload={})
    context = StreamContext(thread_id="t1", reconnect_count=2)
    await stream._router.dispatch(event, context)
    assert router.dispatched == [(event, context)]
