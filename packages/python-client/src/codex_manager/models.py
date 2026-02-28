"""Public data models for codex-manager client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class StreamEvent:
    type: str
    thread_id: str | None
    payload: Any

    @classmethod
    def from_json(cls, body: dict[str, Any]) -> StreamEvent:
        return cls(
            type=str(body.get("type") or "unknown"),
            thread_id=body.get("threadId") if isinstance(body.get("threadId"), str) else None,
            payload=body.get("payload"),
        )


@dataclass(slots=True)
class AppServerSignal:
    event_type: str
    method: str | None
    signal_type: str | None
    received_at: str | None
    context: dict[str, Any]
    params: Any
    session: dict[str, Any] | None
    request_id: str | int | None

    @classmethod
    def from_stream_event(cls, event: StreamEvent) -> AppServerSignal:
        payload = event.payload if isinstance(event.payload, dict) else {}
        request_id = payload.get("requestId")
        if not isinstance(request_id, (str, int)):
            request_id = None

        session = payload.get("session")
        if not isinstance(session, dict):
            session = None

        context = payload.get("context")
        if not isinstance(context, dict):
            context = {}

        return cls(
            event_type=event.type,
            method=payload.get("method") if isinstance(payload.get("method"), str) else None,
            signal_type=payload.get("signalType")
            if isinstance(payload.get("signalType"), str)
            else None,
            received_at=payload.get("receivedAt")
            if isinstance(payload.get("receivedAt"), str)
            else None,
            context=context,
            params=payload.get("params"),
            session=session,
            request_id=request_id,
        )
