from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from codex_manager import AsyncCodexManager, CodexManager
from codex_manager.errors import WaitTimeoutError
from codex_manager.wait import AsyncWaitApi, WaitApi


def test_wait_until_sync_returns_when_predicate_matches() -> None:
    values = iter([0, 0, 3])
    waiter = WaitApi(sessions_api=object())
    result = waiter.until(
        lambda: next(values),
        predicate=lambda value: value == 3,
        timeout_seconds=2,
        interval_seconds=0.01,
    )
    assert result == 3


def test_wait_until_sync_raises_timeout() -> None:
    waiter = WaitApi(sessions_api=object())
    with pytest.raises(WaitTimeoutError):
        waiter.until(
            lambda: 0,
            predicate=lambda value: value == 1,
            timeout_seconds=0.05,
            interval_seconds=0.01,
        )


def test_wait_until_sync_honors_max_attempts() -> None:
    waiter = WaitApi(sessions_api=object())
    attempts = {"count": 0}

    def _poll() -> int:
        attempts["count"] += 1
        return 0

    with pytest.raises(WaitTimeoutError):
        waiter.until(
            _poll,
            predicate=lambda value: value == 1,
            timeout_seconds=5,
            interval_seconds=0.01,
            max_attempts=3,
        )
    assert attempts["count"] == 3


def test_wait_until_sync_rejects_invalid_args() -> None:
    waiter = WaitApi(sessions_api=object())
    with pytest.raises(ValueError):
        waiter.until(lambda: 1, timeout_seconds=0)
    with pytest.raises(ValueError):
        waiter.until(lambda: 1, interval_seconds=0)
    with pytest.raises(ValueError):
        waiter.until(lambda: 1, initial_delay_seconds=-1)
    with pytest.raises(ValueError):
        waiter.until(lambda: 1, max_attempts=0)


@pytest.mark.asyncio
async def test_wait_until_async_returns_when_predicate_matches() -> None:
    state = {"count": 0}

    async def poll() -> int:
        state["count"] += 1
        return state["count"]

    async_waiter = AsyncWaitApi(sessions_api=object())
    result = await async_waiter.until(
        poll, predicate=lambda value: value >= 3, timeout_seconds=2, interval_seconds=0.01
    )
    assert result >= 3


@pytest.mark.asyncio
async def test_wait_until_async_raises_timeout() -> None:
    async_waiter = AsyncWaitApi(sessions_api=object())
    with pytest.raises(WaitTimeoutError):
        await async_waiter.until(
            lambda: 0,
            predicate=lambda value: value == 1,
            timeout_seconds=0.05,
            interval_seconds=0.01,
        )


@pytest.mark.asyncio
async def test_wait_until_async_supports_async_predicate() -> None:
    async_waiter = AsyncWaitApi(sessions_api=object())
    values = iter([0, 0, 2])

    async def _poll() -> int:
        return next(values)

    async def _predicate(value: int) -> bool:
        return value == 2

    result = await async_waiter.until(
        _poll, predicate=_predicate, timeout_seconds=1, interval_seconds=0.01
    )
    assert result == 2


@pytest.mark.asyncio
async def test_wait_until_async_rejects_invalid_args() -> None:
    async_waiter = AsyncWaitApi(sessions_api=object())
    with pytest.raises(ValueError):
        await async_waiter.until(lambda: 1, timeout_seconds=0)
    with pytest.raises(ValueError):
        await async_waiter.until(lambda: 1, interval_seconds=0)
    with pytest.raises(ValueError):
        await async_waiter.until(lambda: 1, initial_delay_seconds=-1)
    with pytest.raises(ValueError):
        await async_waiter.until(lambda: 1, max_attempts=0)


class _SyncSessions:
    def __init__(self) -> None:
        self.get_calls = 0

    def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        return {"status": "accepted", "sessionId": session_id, "turnId": "turn-1"}

    def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        if self.get_calls < 3:
            return {"session": {"sessionId": session_id}, "transcript": []}
        return {
            "session": {"sessionId": session_id},
            "transcript": [
                {
                    "turnId": "turn-1",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Repository summary",
                }
            ],
        }


class _AsyncSessions:
    def __init__(self) -> None:
        self.get_calls = 0

    async def send_message(self, *, session_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        return {"status": "accepted", "sessionId": session_id, "turnId": "turn-2"}

    async def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        if self.get_calls < 2:
            return {"session": {"sessionId": session_id}, "transcript": []}
        return {
            "session": {"sessionId": session_id},
            "transcript": [
                {
                    "turnId": "turn-2",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Async repository summary",
                }
            ],
        }


class _AsyncSessionsTurnStatus:
    def __init__(self) -> None:
        self.get_calls = 0

    async def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        if self.get_calls == 1:
            return {
                "session": {"sessionId": session_id},
                "thread": {"id": session_id, "turns": [{"id": "turn-4", "status": "inProgress"}]},
                "transcript": [
                    {
                        "turnId": "turn-4",
                        "role": "assistant",
                        "status": "complete",
                        "content": "Working",
                    }
                ],
            }
        return {
            "session": {"sessionId": session_id},
            "thread": {"id": session_id, "turns": [{"id": "turn-4", "status": "completed"}]},
            "transcript": [
                {
                    "turnId": "turn-4",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Working",
                },
                {
                    "turnId": "turn-4",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Final async",
                },
            ],
        }


class _SyncSessionsTerminalNoReply:
    def __init__(self) -> None:
        self.get_calls = 0

    def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        return {
            "session": {"sessionId": session_id},
            "thread": {"id": session_id, "turns": [{"id": "turn-5", "status": "completed"}]},
            "transcript": [],
        }


class _AsyncSessionsTerminalNoReply:
    def __init__(self) -> None:
        self.get_calls = 0

    async def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        return {
            "session": {"sessionId": session_id},
            "thread": {"id": session_id, "turns": [{"id": "turn-6", "status": "completed"}]},
            "transcript": [],
        }


def test_send_message_and_wait_reply_sync() -> None:
    sessions = _SyncSessions()
    waiter = WaitApi(sessions_api=sessions)
    result = waiter.send_message_and_wait_reply(
        session_id="session-1",
        text="Summarize repository",
        timeout_seconds=1,
        interval_seconds=0.01,
    )
    assert result.turn_id == "turn-1"
    assert result.assistant_reply == "Repository summary"
    assert isinstance(result.accepted, dict)


class _SyncSessionsTurnStatus:
    def __init__(self) -> None:
        self.get_calls = 0

    def get(self, *, session_id: str) -> dict[str, Any]:
        self.get_calls += 1
        if self.get_calls == 1:
            return {
                "session": {"sessionId": session_id},
                "thread": {"id": session_id, "turns": [{"id": "turn-3", "status": "inProgress"}]},
                "transcript": [
                    {
                        "turnId": "turn-3",
                        "role": "assistant",
                        "status": "complete",
                        "content": "Working on it",
                    }
                ],
            }
        return {
            "session": {"sessionId": session_id},
            "thread": {"id": session_id, "turns": [{"id": "turn-3", "status": "completed"}]},
            "transcript": [
                {
                    "turnId": "turn-3",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Working on it",
                },
                {
                    "turnId": "turn-3",
                    "role": "assistant",
                    "status": "complete",
                    "content": "Final answer",
                },
            ],
        }


def test_assistant_reply_waits_for_terminal_turn_when_status_available() -> None:
    sessions = _SyncSessionsTurnStatus()
    waiter = WaitApi(sessions_api=sessions)
    result = waiter.assistant_reply(
        session_id="session-3", turn_id="turn-3", timeout_seconds=1, interval_seconds=0.01
    )
    assert result.assistant_reply == "Final answer"
    assert sessions.get_calls >= 2


def test_turn_status_sync_returns_current_status_without_expected() -> None:
    sessions = _SyncSessionsTurnStatus()
    waiter = WaitApi(sessions_api=sessions)
    status = waiter.turn_status(session_id="session-3", turn_id="turn-3")
    assert status == "inProgress"


def test_turn_status_sync_waits_for_expected_status() -> None:
    sessions = _SyncSessionsTurnStatus()
    waiter = WaitApi(sessions_api=sessions)
    status = waiter.turn_status(
        session_id="session-3",
        turn_id="turn-3",
        expected={"completed", "failed"},
        timeout_seconds=1,
        interval_seconds=0.01,
    )
    assert status == "completed"
    assert sessions.get_calls >= 2


def test_assistant_reply_fails_fast_when_turn_is_terminal_without_reply() -> None:
    sessions = _SyncSessionsTerminalNoReply()
    waiter = WaitApi(sessions_api=sessions)
    with pytest.raises(WaitTimeoutError, match="completed without an assistant reply"):
        waiter.assistant_reply(
            session_id="session-5", turn_id="turn-5", timeout_seconds=5, interval_seconds=0.01
        )
    assert sessions.get_calls == 1


@pytest.mark.asyncio
async def test_send_message_and_wait_reply_async() -> None:
    sessions = _AsyncSessions()
    waiter = AsyncWaitApi(sessions_api=sessions)
    result = await waiter.send_message_and_wait_reply(
        session_id="session-2",
        text="Summarize repository",
        timeout_seconds=1,
        interval_seconds=0.01,
    )
    assert result.turn_id == "turn-2"
    assert result.assistant_reply == "Async repository summary"
    assert isinstance(result.accepted, dict)


@pytest.mark.asyncio
async def test_async_assistant_reply_waits_for_terminal_turn_when_status_available() -> None:
    sessions = _AsyncSessionsTurnStatus()
    waiter = AsyncWaitApi(sessions_api=sessions)
    result = await waiter.assistant_reply(
        session_id="session-4",
        turn_id="turn-4",
        timeout_seconds=1,
        interval_seconds=0.01,
    )
    assert result.assistant_reply == "Final async"
    assert sessions.get_calls >= 2


@pytest.mark.asyncio
async def test_turn_status_async_returns_current_status_without_expected() -> None:
    sessions = _AsyncSessionsTurnStatus()
    waiter = AsyncWaitApi(sessions_api=sessions)
    status = await waiter.turn_status(session_id="session-4", turn_id="turn-4")
    assert status == "inProgress"


@pytest.mark.asyncio
async def test_turn_status_async_waits_for_expected_status() -> None:
    sessions = _AsyncSessionsTurnStatus()
    waiter = AsyncWaitApi(sessions_api=sessions)
    status = await waiter.turn_status(
        session_id="session-4",
        turn_id="turn-4",
        expected=["completed", "failed"],
        timeout_seconds=1,
        interval_seconds=0.01,
    )
    assert status == "completed"
    assert sessions.get_calls >= 2


@pytest.mark.asyncio
async def test_async_assistant_reply_fails_fast_when_turn_is_terminal_without_reply() -> None:
    sessions = _AsyncSessionsTerminalNoReply()
    waiter = AsyncWaitApi(sessions_api=sessions)
    with pytest.raises(WaitTimeoutError, match="completed without an assistant reply"):
        await waiter.assistant_reply(
            session_id="session-6", turn_id="turn-6", timeout_seconds=5, interval_seconds=0.01
        )
    assert sessions.get_calls == 1


@dataclass
class _SyncExecutor:
    calls: list[dict[str, Any]] = field(default_factory=list)

    def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return {"status": "ok"}


@dataclass
class _AsyncExecutor:
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return {"status": "ok"}


def test_sync_client_exposes_wait_facade() -> None:
    client = CodexManager(request_executor=_SyncExecutor())
    try:
        assert isinstance(client.wait, WaitApi)
    finally:
        client.close()


@pytest.mark.asyncio
async def test_async_client_exposes_wait_facade() -> None:
    client = AsyncCodexManager(request_executor=_AsyncExecutor())
    try:
        assert isinstance(client.wait, AsyncWaitApi)
    finally:
        await client.close()
