from __future__ import annotations

from typing import Any

import pytest

from codex_manager.models import AppServerSignal
from codex_manager.remote_skills import AsyncRemoteSkillsFacade, RemoteSkillsFacade


class _SyncSessions:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.resume_calls: list[dict[str, Any]] = []
        self.create_calls: list[dict[str, Any]] = []
        self.tool_calls_payload: dict[str, Any] = {"data": []}
        self._next_session = 1

    def create(self, **kwargs: Any) -> dict[str, Any]:
        self.create_calls.append(dict(kwargs))
        session_id = f"session-{self._next_session}"
        self._next_session += 1
        return {"session": {"sessionId": session_id}}

    def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id}

    def resume(self, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, **kwargs}
        self.resume_calls.append(call)
        return {"status": "ok", "sessionId": session_id}

    def tool_calls(self, *, session_id: str) -> dict[str, Any]:
        return self.tool_calls_payload


class _SyncWait:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def assistant_reply(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(dict(kwargs))
        return {"assistant_reply": "OK"}


class _SyncSessionsNoRollout(_SyncSessions):
    def __init__(self) -> None:
        super().__init__()
        self.resume_attempts = 0
        self.rollback_calls: list[dict[str, Any]] = []

    def get(self, *, session_id: str) -> dict[str, Any]:
        return {"session": {"sessionId": session_id, "materialized": False}}

    def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id, "turnId": "bootstrap-turn"}

    def resume(self, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.resume_attempts += 1
        call = {"session_id": session_id, **kwargs}
        self.resume_calls.append(call)
        if self.resume_attempts == 1:
            raise RuntimeError("rpc error: no rollout found for thread id session-bootstrap")
        return {"status": "ok", "sessionId": session_id}

    def rollback(self, *, session_id: str, num_turns: int = 1) -> dict[str, Any]:
        call = {"session_id": session_id, "num_turns": num_turns}
        self.rollback_calls.append(call)
        return {"status": "ok", "sessionId": session_id}


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


class _SyncToolCallsNotFound(_SyncToolCalls):
    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "not_found", "requestId": request_id}


class _SyncToolCallsServerError(_SyncToolCalls):
    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "error", "requestId": request_id, "message": "runtime failure"}


class _SyncToolCallsFlaky(_SyncToolCalls):
    def __init__(self) -> None:
        super().__init__()
        self._attempt = 0

    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        self._attempt += 1
        call = {"request_id": request_id, **kwargs, "attempt": self._attempt}
        self.calls.append(call)
        if self._attempt == 1:
            return {
                "status": "error",
                "requestId": request_id,
                "message": "temporary upstream failure",
            }
        return {"status": "ok", "requestId": request_id}


class _SyncToolCallsExceptionFlaky(_SyncToolCalls):
    def __init__(self) -> None:
        super().__init__()
        self._attempt = 0

    def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        self._attempt += 1
        call = {"request_id": request_id, **kwargs, "attempt": self._attempt}
        self.calls.append(call)
        if self._attempt == 1:
            raise RuntimeError("transient transport failure")
        return {"status": "ok", "requestId": request_id}


class _SyncClient:
    def __init__(self) -> None:
        self.sessions = _SyncSessions()
        self.tool_calls = _SyncToolCalls()


class _SyncClientNoRollout:
    def __init__(self) -> None:
        self.sessions = _SyncSessionsNoRollout()
        self.tool_calls = _SyncToolCalls()
        self.wait = _SyncWait()


class _AsyncSessions:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.resume_calls: list[dict[str, Any]] = []
        self.create_calls: list[dict[str, Any]] = []
        self.tool_calls_payload: dict[str, Any] = {"data": []}
        self._next_session = 1

    async def create(self, **kwargs: Any) -> dict[str, Any]:
        self.create_calls.append(dict(kwargs))
        session_id = f"session-{self._next_session}"
        self._next_session += 1
        return {"session": {"sessionId": session_id}}

    async def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id}

    async def resume(self, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, **kwargs}
        self.resume_calls.append(call)
        return {"status": "ok", "sessionId": session_id}

    async def tool_calls(self, *, session_id: str) -> dict[str, Any]:
        return self.tool_calls_payload


class _AsyncWait:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def assistant_reply(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(dict(kwargs))
        return {"assistant_reply": "OK"}


class _AsyncSessionsNoRollout(_AsyncSessions):
    def __init__(self) -> None:
        super().__init__()
        self.resume_attempts = 0
        self.rollback_calls: list[dict[str, Any]] = []

    async def get(self, *, session_id: str) -> dict[str, Any]:
        return {"session": {"sessionId": session_id, "materialized": False}}

    async def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        call = {"session_id": session_id, "text": text, **kwargs}
        self.calls.append(call)
        return {"status": "accepted", "sessionId": session_id, "turnId": "bootstrap-turn"}

    async def resume(self, *, session_id: str, **kwargs: Any) -> dict[str, Any]:
        self.resume_attempts += 1
        call = {"session_id": session_id, **kwargs}
        self.resume_calls.append(call)
        if self.resume_attempts == 1:
            raise RuntimeError("rpc error: no rollout found for thread id session-bootstrap")
        return {"status": "ok", "sessionId": session_id}

    async def rollback(self, *, session_id: str, num_turns: int = 1) -> dict[str, Any]:
        call = {"session_id": session_id, "num_turns": num_turns}
        self.rollback_calls.append(call)
        return {"status": "ok", "sessionId": session_id}


class _AsyncToolCalls:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "ok", "requestId": request_id}


class _AsyncToolCallsConflict(_AsyncToolCalls):
    async def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        call = {"request_id": request_id, **kwargs}
        self.calls.append(call)
        return {"status": "conflict", "code": "in_flight", "requestId": request_id}


class _AsyncToolCallsFlaky(_AsyncToolCalls):
    def __init__(self) -> None:
        super().__init__()
        self._attempt = 0

    async def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        self._attempt += 1
        call = {"request_id": request_id, **kwargs, "attempt": self._attempt}
        self.calls.append(call)
        if self._attempt == 1:
            return {
                "status": "error",
                "requestId": request_id,
                "message": "temporary upstream failure",
            }
        return {"status": "ok", "requestId": request_id}


class _AsyncToolCallsExceptionFlaky(_AsyncToolCalls):
    def __init__(self) -> None:
        super().__init__()
        self._attempt = 0

    async def respond(self, *, request_id: str, **kwargs: Any) -> dict[str, Any]:
        self._attempt += 1
        call = {"request_id": request_id, **kwargs, "attempt": self._attempt}
        self.calls.append(call)
        if self._attempt == 1:
            raise RuntimeError("transient transport failure")
        return {"status": "ok", "requestId": request_id}


class _AsyncClient:
    def __init__(self) -> None:
        self.sessions = _AsyncSessions()
        self.tool_calls = _AsyncToolCalls()


class _AsyncClientNoRollout:
    def __init__(self) -> None:
        self.sessions = _AsyncSessionsNoRollout()
        self.tool_calls = _AsyncToolCalls()
        self.wait = _AsyncWait()


def _tool_call_signal(
    tool: str,
    arguments: Any,
    request_id: int | str = 7,
    *,
    session_id: str | None = None,
) -> AppServerSignal:
    return AppServerSignal(
        event_type="app_server.request.item.tool.call",
        method="item/tool/call",
        signal_type="request",
        received_at=None,
        context={"threadId": session_id} if session_id else {},
        params={"tool": tool, "arguments": arguments, "callId": "call-1"},
        session={"id": session_id} if session_id else None,
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


def test_sync_remote_skills_send_passes_dynamic_tools_payload() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-dynamic")

    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id},
        description="Lookup ticket state by id",
        input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
    )

    session.send("Lookup", inject_skills=False)

    dynamic_tools = client.sessions.calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "lookup_ticket"


def test_sync_remote_skills_create_session_registers_tools_on_create() -> None:
    client = _SyncClient()
    facade = RemoteSkillsFacade(client)

    def register(skills: Any) -> None:
        skills.register(
            "lookup_ticket",
            lambda ticket_id: {"ticketId": ticket_id},
            description="Lookup ticket state by id",
            input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
        )

    created, session = facade.create_session(register=register, cwd=".")

    assert isinstance(created, dict)
    assert client.sessions.create_calls
    dynamic_tools = client.sessions.create_calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "lookup_ticket"
    assert session.session_id == "session-1"
    assert session.list() and session.list()[0].name == "lookup_ticket"


def test_sync_remote_skills_create_session_rejects_async_register_callback() -> None:
    client = _SyncClient()
    facade = RemoteSkillsFacade(client)

    async def register(skills: Any) -> None:
        skills.register("ping", lambda: "pong", description="Health check")

    with pytest.raises(TypeError):
        facade.create_session(register=register, cwd=".")


def test_sync_remote_skills_send_prepared_bootstraps_unmaterialized_session() -> None:
    client = _SyncClientNoRollout()
    session = RemoteSkillsFacade(client).session("session-bootstrap")
    session.register("ping", lambda: "pong", description="Health check")

    session.send_prepared("Ping once", inject_skills=False, prepare_timeout_seconds=5)

    assert client.sessions.resume_attempts >= 2
    assert client.sessions.rollback_calls
    assert client.wait.calls and client.wait.calls[0]["turn_id"] == "bootstrap-turn"
    assert client.sessions.calls and client.sessions.calls[-1]["text"] == "Ping once"


def test_sync_remote_skills_sync_runtime_resumes_with_dynamic_tools() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-sync")
    session.register("ping", lambda: "pong", description="Health check")

    session.sync_runtime()

    assert client.sessions.resume_calls
    dynamic_tools = client.sessions.resume_calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "ping"
    assert dynamic_tools[0].get("inputSchema") == {
        "type": "object",
        "properties": {},
        "additionalProperties": True,
    }


def test_sync_remote_skills_respond_to_signal_posts_tool_call_response() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-2")

    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(
        _tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=42)
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 1
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
    dispatched = session.respond_to_signal(
        _tool_call_signal("missing_tool", {"x": 1}, request_id="abc")
    )
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

    dispatched = session.respond_to_signal(
        _tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=55)
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "conflict"
    assert dispatched.submission_code == "in_flight"
    assert dispatched.submission_idempotent is True


def test_sync_remote_skills_treats_not_found_as_idempotent_success() -> None:
    client = _SyncClient()
    client.tool_calls = _SyncToolCallsNotFound()
    session = RemoteSkillsFacade(client).session("session-6a")
    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(
        _tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=57)
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "not_found"
    assert dispatched.submission_idempotent is True


def test_sync_remote_skills_marks_dispatch_failed_when_response_is_server_error() -> None:
    client = _SyncClient()
    client.tool_calls = _SyncToolCallsServerError()
    session = RemoteSkillsFacade(client).session("session-6b")
    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(
        _tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=56)
    )

    assert dispatched is not None
    assert dispatched.handled is False
    assert dispatched.error is not None
    assert "status=error" in dispatched.error


def test_sync_remote_skills_retries_response_submission_and_succeeds() -> None:
    client = _SyncClient()
    client.tool_calls = _SyncToolCallsFlaky()
    session = RemoteSkillsFacade(client).session("session-retry")
    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    dispatched = session.respond_to_signal(
        _tool_call_signal("lookup_ticket", {"ticket_id": "ABC-123"}, request_id=58),
        max_submit_attempts=3,
        retry_delay_seconds=0.0,
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 2
    assert len(client.tool_calls.calls) == 2


def test_sync_remote_skills_retries_submit_exception_when_delay_is_zero() -> None:
    client = _SyncClient()
    client.tool_calls = _SyncToolCallsExceptionFlaky()
    session = RemoteSkillsFacade(client).session("session-retry-exception")
    session.register("ping", lambda: "pong", description="Health check")

    dispatched = session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id=59, session_id="session-retry-exception"),
        max_submit_attempts=3,
        retry_delay_seconds=0.0,
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 2
    assert len(client.tool_calls.calls) == 2


def test_sync_remote_skills_respond_to_pending_call() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-pending")
    session.register(
        "lookup_ticket",
        lambda ticket_id: {"ticketId": ticket_id, "status": "open"},
        description="Lookup ticket state by id",
    )

    pending = {
        "requestId": "123",
        "tool": "lookup_ticket",
        "arguments": {"ticket_id": "ABC-123"},
        "callId": "c-1",
    }
    dispatched = session.respond_to_pending_call(pending)

    assert dispatched is not None
    assert dispatched.handled is True
    assert client.tool_calls.calls and client.tool_calls.calls[0]["request_id"] == "123"


def test_sync_remote_skills_ignores_mismatched_session_signal() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-a")
    session.register("ping", lambda: "pong", description="Health check")

    dispatched = session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id="req-1", session_id="session-b"),
    )

    assert dispatched is None
    assert client.tool_calls.calls == []


def test_sync_remote_skills_local_duplicate_short_circuits_submit() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-dup")
    session.register("ping", lambda: "pong", description="Health check")

    first = session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id="dup-1", session_id="session-dup")
    )
    second = session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id="dup-1", session_id="session-dup")
    )

    assert first is not None and first.handled is True
    assert second is not None and second.handled is True
    assert second.submission_status == "local_duplicate"
    assert second.submission_idempotent is True
    assert len(client.tool_calls.calls) == 1


def test_sync_remote_skills_drain_pending_calls() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-drain")
    session.register("ping", lambda: "pong", description="Health check")
    client.sessions.tool_calls_payload = {
        "data": [{"requestId": "9", "tool": "ping", "arguments": {}}]
    }

    drained = session.drain_pending_calls()

    assert len(drained) == 1
    assert drained[0].tool == "ping"
    assert client.tool_calls.calls and client.tool_calls.calls[0]["request_id"] == "9"


def test_sync_remote_skills_drain_pending_calls_tolerates_deleted_or_system_sessions() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-drain-empty")

    client.sessions.tool_calls_payload = {"status": "deleted"}
    assert session.drain_pending_calls() == []

    client.sessions.tool_calls_payload = {"status": "error", "code": "system_session"}
    assert session.drain_pending_calls() == []


def test_sync_remote_skills_drain_pending_calls_rejects_malformed_payload() -> None:
    client = _SyncClient()
    session = RemoteSkillsFacade(client).session("session-drain-malformed")
    client.sessions.tool_calls_payload = {"status": "ok"}

    with pytest.raises(ValueError, match="missing data list"):
        session.drain_pending_calls()


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
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 1
    assert client.tool_calls.calls[0]["request_id"] == "7"

    await session.send("Summarize the tool output")
    assert (
        client.sessions.calls and "Session remote skill catalog" in client.sessions.calls[0]["text"]
    )


@pytest.mark.asyncio
async def test_async_remote_skills_sync_runtime_resumes_with_dynamic_tools() -> None:
    client = _AsyncClient()
    session = AsyncRemoteSkillsFacade(client).session("session-async-sync")
    session.register("ping", lambda: "pong", description="Health check")

    await session.sync_runtime()

    assert client.sessions.resume_calls
    dynamic_tools = client.sessions.resume_calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "ping"
    assert dynamic_tools[0].get("inputSchema") == {
        "type": "object",
        "properties": {},
        "additionalProperties": True,
    }


@pytest.mark.asyncio
async def test_async_remote_skills_create_session_registers_tools_on_create() -> None:
    client = _AsyncClient()
    facade = AsyncRemoteSkillsFacade(client)

    def register(skills: Any) -> None:
        skills.register(
            "lookup_ticket",
            lambda ticket_id: {"ticketId": ticket_id},
            description="Lookup ticket state by id",
            input_schema={"type": "object", "properties": {"ticket_id": {"type": "string"}}},
        )

    created, session = await facade.create_session(register=register, cwd=".")

    assert isinstance(created, dict)
    assert client.sessions.create_calls
    dynamic_tools = client.sessions.create_calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "lookup_ticket"
    assert session.session_id == "session-1"
    assert session.list() and session.list()[0].name == "lookup_ticket"


@pytest.mark.asyncio
async def test_async_remote_skills_create_session_supports_async_register_callback() -> None:
    client = _AsyncClient()
    facade = AsyncRemoteSkillsFacade(client)

    async def register(skills: Any) -> None:
        skills.register("ping", lambda: "pong", description="Health check")

    created, session = await facade.create_session(register=register, cwd=".")

    assert isinstance(created, dict)
    dynamic_tools = client.sessions.create_calls[0].get("dynamic_tools")
    assert isinstance(dynamic_tools, list)
    assert dynamic_tools and dynamic_tools[0]["name"] == "ping"
    assert session.list() and session.list()[0].name == "ping"


@pytest.mark.asyncio
async def test_async_remote_skills_send_prepared_bootstraps_unmaterialized_session() -> None:
    client = _AsyncClientNoRollout()
    session = AsyncRemoteSkillsFacade(client).session("session-bootstrap")
    session.register("ping", lambda: "pong", description="Health check")

    await session.send_prepared("Ping once", inject_skills=False, prepare_timeout_seconds=5)

    assert client.sessions.resume_attempts >= 2
    assert client.sessions.rollback_calls
    assert client.wait.calls and client.wait.calls[0]["turn_id"] == "bootstrap-turn"
    assert client.sessions.calls and client.sessions.calls[-1]["text"] == "Ping once"


@pytest.mark.asyncio
async def test_async_remote_skills_drain_pending_calls() -> None:
    client = _AsyncClient()
    session = AsyncRemoteSkillsFacade(client).session("session-async-drain")
    session.register("ping", lambda: "pong", description="Health check")
    client.sessions.tool_calls_payload = {
        "data": [{"requestId": "7", "tool": "ping", "arguments": {}}]
    }

    drained = await session.drain_pending_calls()

    assert len(drained) == 1
    assert drained[0].tool == "ping"
    assert client.tool_calls.calls and client.tool_calls.calls[0]["request_id"] == "7"


@pytest.mark.asyncio
async def test_async_remote_skills_drain_pending_calls_rejects_malformed_payload() -> None:
    client = _AsyncClient()
    session = AsyncRemoteSkillsFacade(client).session("session-async-drain-malformed")
    client.sessions.tool_calls_payload = {"status": "ok"}

    with pytest.raises(ValueError, match="missing data list"):
        await session.drain_pending_calls()


@pytest.mark.asyncio
async def test_async_remote_skills_treats_conflict_as_idempotent_success() -> None:
    client = _AsyncClient()
    client.tool_calls = _AsyncToolCallsConflict()
    session = AsyncRemoteSkillsFacade(client).session("session-async-conflict")
    session.register("ping", lambda: "pong", description="Health check")

    dispatched = await session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id="ac-1", session_id="session-async-conflict")
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "conflict"
    assert dispatched.submission_code == "in_flight"
    assert dispatched.submission_idempotent is True


@pytest.mark.asyncio
async def test_async_remote_skills_retry_response_submission() -> None:
    client = _AsyncClient()
    client.tool_calls = _AsyncToolCallsFlaky()
    session = AsyncRemoteSkillsFacade(client).session("session-async-retry")
    session.register("ping", lambda: "pong", description="Health check")

    dispatched = await session.respond_to_signal(
        _tool_call_signal("ping", {}, request_id="ac-2", session_id="session-async-retry"),
        max_submit_attempts=3,
        retry_delay_seconds=0.0,
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 2
    assert len(client.tool_calls.calls) == 2


@pytest.mark.asyncio
async def test_async_remote_skills_retries_submit_exception_when_delay_is_zero() -> None:
    client = _AsyncClient()
    client.tool_calls = _AsyncToolCallsExceptionFlaky()
    session = AsyncRemoteSkillsFacade(client).session("session-async-retry-exception")
    session.register("ping", lambda: "pong", description="Health check")

    dispatched = await session.respond_to_signal(
        _tool_call_signal(
            "ping", {}, request_id="ac-3", session_id="session-async-retry-exception"
        ),
        max_submit_attempts=3,
        retry_delay_seconds=0.0,
    )

    assert dispatched is not None
    assert dispatched.handled is True
    assert dispatched.submission_status == "ok"
    assert dispatched.submission_attempts == 2
    assert len(client.tool_calls.calls) == 2
