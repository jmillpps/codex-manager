from __future__ import annotations

from typing import Any

import pytest

from codex_manager.models import AppServerSignal
from codex_manager.remote_skills import AsyncRemoteSkillsFacade, RemoteSkillsFacade


class _SyncSessions:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id}


class _SyncToolCalls:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "ok", "requestId": request_id}


class _SyncToolCallsConflict(_SyncToolCalls):
    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "conflict", "code": "in_flight", "requestId": request_id}


class _SyncClient:
    def __init__(self) -> None:
        self.sessions = _SyncSessions()
        self.tool_calls = _SyncToolCalls()


class _AsyncSessions:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id}


class _AsyncToolCalls:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "ok", "requestId": request_id}


class _AsyncClient:
    def __init__(self) -> None:
        self.sessions = _AsyncSessions()
        self.tool_calls = _AsyncToolCalls()


def _tool_call_signal(tool: str, arguments: Any, request_id: int | str = 7) -> AppServerSignal:
    return AppServerSignal(
        event_type="app_server.request.item.tool.call",
        method="item/tool/call",
        signal_type="request",
        received_at=None,
        context={},
        params={"tool": tool, "arguments": arguments, "callId": "call-1"},
        session=None,
        request_id=request_id,
    )


def test_sync_remote_skills_using_injects_and_cleans_up() -> None:
    client = _SyncClient()
    facade = RemoteSkillsFacade(client)

    def lookup_ticket(ticket_id: str) -> dict[str, str]:
        return {"ticketId": ticket_id, "status": "open"}

    with facade.using(
        "session-1",
        "lookup_ticket",
        lookup_ticket,
        description="Lookup ticket state by id",
        input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
    ) as scoped:
        scoped.send("Find blockers for ticket ABC-123")

        assert len(scoped.list()) == 1
        assert "Session remote skill catalog" in client.sessions.calls[0]["text"]
        assert "lookup_ticket" in client.sessions.calls[0]["text"]

    assert scoped.list() == []


def test_sync_remote_skills_respond_to_signal_posts_tool_call_response() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-2")

    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(_tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=42))

    assert dispatched is not None
    assert dispatched.handled is True
    assert client.tool_calls.calls[0]["request_id"] == "42"
    assert isinstance(client.tool_calls.calls[0]["response"], dict)


def test_sync_remote_skills_reject_async_handler_in_sync_context() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-3")

    async def async_skill(value: str) -> str:
        return value

    session.register("async_skill", async_skill, description="Async-only skill")
    dispatched = session.dispatch_tool_call(tool="async_skill", arguments={"value": "x"})
    assert dispatched.handled is False
    assert dispatched.error is not None


def test_sync_remote_skills_unknown_tool_posts_failure_payload() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-5")
    dispatched = session.respond_to_signal(_tool_call_signal("missing_tool", {"x": 1}, request_id="abc"))
    assert dispatched is not None
    assert dispatched.handled is False
    assert client.tool_calls.calls[0]["request_id"] == "abc"
    response = client.tool_calls.calls[0]["response"]
    assert isinstance(response, dict)
    assert response.get("success") is False


def test_sync_remote_skills_marks_dispatch_failed_when_response_is_conflict() -> None:
    client = _SyncClient()
    client.tool_calls = _SyncToolCallsConflict()
    session = RemoteSkillsFacade(client).session("session-6")
    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(_tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=55))

    assert dispatched is not None
    assert dispatched.handled is False
    assert dispatched.error is not None
    assert "status=conflict" in dispatched.error


@pytest.mark.asyncio
async def test_async_remote_skills_can_dispatch_and_respond() -> None:
    client = _AsyncClient()
    session = AsyncRemoteSkillsFacade(client).session("session-4")

    @session.skill(description="Uppercase text")
    async def uppercase(text: str) -> str:
        return text.upper()

    dispatched = await session.respond_to_signal(_tool_call_signal("uppercase", {"text": "hello"}))
    assert dispatched is not None
    assert dispatched.handled is True
    assert client.tool_calls.calls[0]["request_id"] == "7"

    await session.send("Summarize the tool output")
    assert client.sessions.calls and "Session remote skill catalog" in client.sessions.calls[0]["text"]
