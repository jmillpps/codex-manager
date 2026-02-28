"""Websocket stream and event-dispatch helpers."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from time import monotonic
from typing import Any
from urllib.parse import urlencode, urlparse, urlunparse

import websockets

from .models import AppServerSignal, StreamEvent
from .protocols import StreamHandler, StreamMatcher, StreamRouter

EventHandler = Callable[[StreamEvent, "StreamContext"], Awaitable[None] | None]
AppServerHandler = Callable[[AppServerSignal, "StreamContext"], Awaitable[None] | None]


@dataclass(slots=True)
class StreamContext:
    thread_id: str | None
    reconnect_count: int


@dataclass(slots=True)
class _Route:
    matcher: StreamMatcher
    handler: EventHandler


class EventRouter(StreamRouter):
    def __init__(
        self,
        *,
        on_handler_error: Callable[[Exception, StreamEvent], Awaitable[None] | None] | None = None,
    ) -> None:
        self._routes: list[_Route] = []
        self._on_handler_error = on_handler_error

    def add(self, matcher: StreamMatcher, handler: StreamHandler) -> None:
        self._routes.append(_Route(matcher=matcher, handler=handler))

    async def dispatch(self, event: StreamEvent, context: StreamContext) -> None:
        for route in self._routes:
            if not route.matcher(event):
                continue
            try:
                result = route.handler(event, context)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                # Handler isolation is intentional: one broken callback must not drop the stream.
                if self._on_handler_error is not None:
                    try:
                        callback_result = self._on_handler_error(error, event)
                        if inspect.isawaitable(callback_result):
                            await callback_result
                    except Exception:
                        # A broken error callback should still not crash stream dispatch.
                        continue


class AsyncEventStream:
    def __init__(
        self,
        *,
        base_url: str,
        api_prefix: str,
        headers: dict[str, str] | None = None,
        reconnect_base_seconds: float = 0.5,
        reconnect_max_seconds: float = 10.0,
        ping_interval_seconds: float = 15.0,
        receive_timeout_seconds: float = 1.0,
        logger: logging.Logger | None = None,
        router: StreamRouter | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_prefix = api_prefix.rstrip("/")
        self._headers = headers or {}
        self._logger = logger or logging.getLogger(__name__)
        self._router = router or EventRouter(on_handler_error=self._handle_handler_error)
        self._reconnect_base = reconnect_base_seconds
        self._reconnect_max = reconnect_max_seconds
        self._ping_interval_seconds = ping_interval_seconds
        self._receive_timeout_seconds = receive_timeout_seconds

    def on_event(self, event_type: str) -> Callable[[EventHandler], EventHandler]:
        def decorator(handler: EventHandler) -> EventHandler:
            self._router.add(lambda event: event.type == event_type, handler)
            return handler

        return decorator

    def on_event_prefix(self, prefix: str) -> Callable[[EventHandler], EventHandler]:
        def decorator(handler: EventHandler) -> EventHandler:
            self._router.add(lambda event: event.type.startswith(prefix), handler)
            return handler

        return decorator

    def on_app_server(self, normalized_method: str) -> Callable[[AppServerHandler], AppServerHandler]:
        event_type = f"app_server.{normalized_method.strip('.')}"

        def decorator(handler: AppServerHandler) -> AppServerHandler:
            async def wrapped(event: StreamEvent, context: StreamContext) -> None:
                signal = AppServerSignal.from_stream_event(event)
                result = handler(signal, context)
                if inspect.isawaitable(result):
                    await result

            self._router.add(lambda event: event.type == event_type, wrapped)
            return handler

        return decorator

    def on_app_server_request(self, normalized_method: str) -> Callable[[AppServerHandler], AppServerHandler]:
        event_type = f"app_server.request.{normalized_method.strip('.')}"

        def decorator(handler: AppServerHandler) -> AppServerHandler:
            async def wrapped(event: StreamEvent, context: StreamContext) -> None:
                signal = AppServerSignal.from_stream_event(event)
                result = handler(signal, context)
                if inspect.isawaitable(result):
                    await result

            self._router.add(lambda event: event.type == event_type, wrapped)
            return handler

        return decorator

    def on_turn_started(self) -> Callable[[EventHandler], EventHandler]:
        return self.on_event("app_server.item.started")

    async def run_forever(
        self,
        *,
        thread_id: str | None = None,
        stop_event: asyncio.Event | None = None,
    ) -> None:
        reconnect_count = 0

        while True:
            if stop_event and stop_event.is_set():
                return

            try:
                async with websockets.connect(self._stream_url(thread_id), additional_headers=self._headers) as ws:
                    await self._run_connection(
                        ws,
                        thread_id=thread_id,
                        stop_event=stop_event,
                        reconnect_count=reconnect_count,
                    )
                    reconnect_count = 0
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._logger.debug("stream connection failed: %s", error)
                reconnect_count += 1
                delay = min(self._reconnect_base * (2 ** max(0, reconnect_count - 1)), self._reconnect_max)
                await asyncio.sleep(delay)

    async def _run_connection(
        self,
        websocket: Any,
        *,
        thread_id: str | None,
        stop_event: asyncio.Event | None,
        reconnect_count: int,
    ) -> None:
        if thread_id:
            await websocket.send(json.dumps({"type": "subscribe", "threadId": thread_id}))
        last_ping_at = monotonic()

        while True:
            if stop_event and stop_event.is_set():
                return

            now = monotonic()
            if (now - last_ping_at) >= self._ping_interval_seconds:
                await websocket.send(json.dumps({"type": "ping"}))
                last_ping_at = now

            try:
                raw = await asyncio.wait_for(websocket.recv(), timeout=self._receive_timeout_seconds)
            except TimeoutError:
                continue

            if not isinstance(raw, str):
                continue

            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                self._logger.debug("ignoring malformed stream message")
                continue

            if not isinstance(parsed, dict):
                continue

            event = StreamEvent.from_json(parsed)
            await self._router.dispatch(event, StreamContext(thread_id=thread_id, reconnect_count=reconnect_count))

    async def _handle_handler_error(self, error: Exception, event: StreamEvent) -> None:
        self._logger.exception("stream handler failed for event %s: %s", event.type, error)

    def _stream_url(self, thread_id: str | None) -> str:
        parsed = urlparse(self._base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        path = f"{self._api_prefix}/stream"

        query = ""
        if thread_id:
            query = urlencode({"threadId": thread_id})

        return urlunparse((scheme, parsed.netloc, path, "", query, ""))


class SyncEventStream:
    def __init__(self, async_stream: AsyncEventStream) -> None:
        self._async_stream = async_stream

    def on_event(self, event_type: str) -> Callable[[EventHandler], EventHandler]:
        return self._async_stream.on_event(event_type)

    def on_event_prefix(self, prefix: str) -> Callable[[EventHandler], EventHandler]:
        return self._async_stream.on_event_prefix(prefix)

    def on_app_server(self, normalized_method: str) -> Callable[[AppServerHandler], AppServerHandler]:
        return self._async_stream.on_app_server(normalized_method)

    def on_app_server_request(self, normalized_method: str) -> Callable[[AppServerHandler], AppServerHandler]:
        return self._async_stream.on_app_server_request(normalized_method)

    def on_turn_started(self) -> Callable[[EventHandler], EventHandler]:
        return self._async_stream.on_turn_started()

    def run_forever(self, *, thread_id: str | None = None) -> None:
        asyncio.run(self._async_stream.run_forever(thread_id=thread_id))
