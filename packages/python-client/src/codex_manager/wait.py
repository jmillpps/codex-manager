"""Sync/async wait helpers for polling-based synchronization."""

from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, TypeVar

from .errors import WaitTimeoutError

T = TypeVar("T")


@dataclass(slots=True)
class SessionTurnReply:
    """Result payload for send-and-wait assistant reply helpers."""

    session_id: str
    turn_id: str
    accepted: Any
    detail: Any
    assistant_reply: str


def _validate_wait_args(
    *,
    timeout_seconds: float,
    interval_seconds: float,
    initial_delay_seconds: float,
    max_attempts: int | None,
) -> None:
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be > 0")
    if interval_seconds <= 0:
        raise ValueError("interval_seconds must be > 0")
    if initial_delay_seconds < 0:
        raise ValueError("initial_delay_seconds must be >= 0")
    if max_attempts is not None and max_attempts <= 0:
        raise ValueError("max_attempts must be > 0 when provided")


def _wait_timeout_message(
    *,
    description: str | None,
    timeout_seconds: float,
    attempts: int,
) -> str:
    subject = description or "wait condition"
    return f"{subject} did not match within {timeout_seconds:.2f}s after {attempts} attempts"


def _assistant_reply_for_turn(detail: Any, turn_id: str) -> str | None:
    if not isinstance(detail, dict):
        return None
    transcript = detail.get("transcript")
    if not isinstance(transcript, list):
        return None

    for entry in reversed(transcript):
        if not isinstance(entry, dict):
            continue
        if entry.get("turnId") != turn_id:
            continue
        if entry.get("role") != "assistant":
            continue
        if entry.get("status") != "complete":
            continue
        content = entry.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    return None


def _turn_status(detail: Any, turn_id: str) -> str | None:
    if not isinstance(detail, dict):
        return None
    thread = detail.get("thread")
    if not isinstance(thread, dict):
        return None
    turns = thread.get("turns")
    if not isinstance(turns, list):
        return None
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if turn.get("id") != turn_id:
            continue
        status = turn.get("status")
        if isinstance(status, str) and status.strip():
            return status.strip()
        return None
    return None


def _is_terminal_turn_status(status: str) -> bool:
    normalized = status.strip().lower()
    return normalized in {
        "completed",
        "complete",
        "failed",
        "error",
        "interrupted",
        "canceled",
        "cancelled",
    }


def _normalize_expected_statuses(expected: str | Iterable[str]) -> set[str]:
    values = [expected] if isinstance(expected, str) else list(expected)
    normalized: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            raise ValueError("expected statuses must be strings")
        candidate = value.strip().lower()
        if candidate:
            normalized.add(candidate)
    if not normalized:
        raise ValueError("expected statuses must include at least one non-empty status")
    return normalized


class WaitApi:
    """Synchronous wait helpers for polling and common session workflows."""

    def __init__(self, sessions_api: Any) -> None:
        self._sessions = sessions_api

    def until(
        self,
        poll: Callable[[], T],
        *,
        predicate: Callable[[T], bool] | None = None,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        initial_delay_seconds: float = 0.0,
        max_attempts: int | None = None,
        description: str | None = None,
    ) -> T:
        _validate_wait_args(
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            initial_delay_seconds=initial_delay_seconds,
            max_attempts=max_attempts,
        )

        if initial_delay_seconds > 0:
            time.sleep(initial_delay_seconds)

        start = time.monotonic()
        attempts = 0
        check = predicate or (lambda value: bool(value))

        while True:
            attempts += 1
            value = poll()
            if check(value):
                return value

            if max_attempts is not None and attempts >= max_attempts:
                raise WaitTimeoutError(
                    _wait_timeout_message(
                        description=description,
                        timeout_seconds=timeout_seconds,
                        attempts=attempts,
                    )
                )

            elapsed = time.monotonic() - start
            if elapsed >= timeout_seconds:
                raise WaitTimeoutError(
                    _wait_timeout_message(
                        description=description,
                        timeout_seconds=timeout_seconds,
                        attempts=attempts,
                    )
                )
            time.sleep(interval_seconds)

    def assistant_reply(
        self,
        *,
        session_id: str,
        turn_id: str,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
    ) -> SessionTurnReply:
        def _reply_ready(payload: Any) -> bool:
            status = _turn_status(payload, turn_id)
            reply = _assistant_reply_for_turn(payload, turn_id)
            if status is None:
                # Backward compatibility for payloads without thread.turns.
                return reply is not None
            if _is_terminal_turn_status(status):
                if reply is not None:
                    return True
                raise WaitTimeoutError(f"turn {turn_id} completed without an assistant reply")
            return False

        detail = self.until(
            lambda: self._sessions.get(session_id=session_id),
            predicate=_reply_ready,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            description=f"assistant reply for turn {turn_id}",
        )
        assistant_reply = _assistant_reply_for_turn(detail, turn_id)
        if assistant_reply is None:
            raise WaitTimeoutError(f"assistant reply for turn {turn_id} was not available")
        return SessionTurnReply(
            session_id=session_id,
            turn_id=turn_id,
            accepted=None,
            detail=detail,
            assistant_reply=assistant_reply,
        )

    def turn_status(
        self,
        *,
        session_id: str,
        turn_id: str,
        expected: str | Iterable[str] | None = None,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
    ) -> str | None:
        if expected is None:
            detail = self._sessions.get(session_id=session_id)
            return _turn_status(detail, turn_id)

        expected_statuses = _normalize_expected_statuses(expected)

        def _matches(payload: Any) -> bool:
            status = _turn_status(payload, turn_id)
            if not isinstance(status, str):
                return False
            return status.strip().lower() in expected_statuses

        detail = self.until(
            lambda: self._sessions.get(session_id=session_id),
            predicate=_matches,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            description=(
                f"turn {turn_id} status in {', '.join(sorted(expected_statuses))}"
            ),
        )
        return _turn_status(detail, turn_id)

    def send_message_and_wait_reply(
        self,
        *,
        session_id: str,
        text: str,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        **send_kwargs: Any,
    ) -> SessionTurnReply:
        accepted = self._sessions.send_message(session_id=session_id, text=text, **send_kwargs)
        if not isinstance(accepted, dict):
            raise ValueError(
                "sessions.send_message returned unexpected payload; expected dict with turnId"
            )
        turn_id = accepted.get("turnId")
        if not isinstance(turn_id, str) or not turn_id.strip():
            raise ValueError("sessions.send_message response missing turnId")

        waited = self.assistant_reply(
            session_id=session_id,
            turn_id=turn_id,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
        )
        return SessionTurnReply(
            session_id=session_id,
            turn_id=turn_id,
            accepted=accepted,
            detail=waited.detail,
            assistant_reply=waited.assistant_reply,
        )


class AsyncWaitApi:
    """Asynchronous wait helpers for polling and common session workflows."""

    def __init__(self, sessions_api: Any) -> None:
        self._sessions = sessions_api

    async def until(
        self,
        poll: Callable[[], T | Awaitable[T]],
        *,
        predicate: Callable[[T], bool | Awaitable[bool]] | None = None,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        initial_delay_seconds: float = 0.0,
        max_attempts: int | None = None,
        description: str | None = None,
    ) -> T:
        _validate_wait_args(
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            initial_delay_seconds=initial_delay_seconds,
            max_attempts=max_attempts,
        )

        if initial_delay_seconds > 0:
            await asyncio.sleep(initial_delay_seconds)

        start = time.monotonic()
        attempts = 0

        while True:
            attempts += 1
            value = poll()
            if inspect.isawaitable(value):
                value = await value

            if predicate is None:
                matched = bool(value)
            else:
                matched_value = predicate(value)
                matched = (
                    await matched_value if inspect.isawaitable(matched_value) else matched_value
                )

            if matched:
                return value

            if max_attempts is not None and attempts >= max_attempts:
                raise WaitTimeoutError(
                    _wait_timeout_message(
                        description=description,
                        timeout_seconds=timeout_seconds,
                        attempts=attempts,
                    )
                )

            elapsed = time.monotonic() - start
            if elapsed >= timeout_seconds:
                raise WaitTimeoutError(
                    _wait_timeout_message(
                        description=description,
                        timeout_seconds=timeout_seconds,
                        attempts=attempts,
                    )
                )
            await asyncio.sleep(interval_seconds)

    async def assistant_reply(
        self,
        *,
        session_id: str,
        turn_id: str,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
    ) -> SessionTurnReply:
        def _reply_ready(payload: Any) -> bool:
            status = _turn_status(payload, turn_id)
            reply = _assistant_reply_for_turn(payload, turn_id)
            if status is None:
                # Backward compatibility for payloads without thread.turns.
                return reply is not None
            if _is_terminal_turn_status(status):
                if reply is not None:
                    return True
                raise WaitTimeoutError(f"turn {turn_id} completed without an assistant reply")
            return False

        detail = await self.until(
            lambda: self._sessions.get(session_id=session_id),
            predicate=_reply_ready,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            description=f"assistant reply for turn {turn_id}",
        )
        assistant_reply = _assistant_reply_for_turn(detail, turn_id)
        if assistant_reply is None:
            raise WaitTimeoutError(f"assistant reply for turn {turn_id} was not available")
        return SessionTurnReply(
            session_id=session_id,
            turn_id=turn_id,
            accepted=None,
            detail=detail,
            assistant_reply=assistant_reply,
        )

    async def turn_status(
        self,
        *,
        session_id: str,
        turn_id: str,
        expected: str | Iterable[str] | None = None,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
    ) -> str | None:
        if expected is None:
            detail = await self._sessions.get(session_id=session_id)
            return _turn_status(detail, turn_id)

        expected_statuses = _normalize_expected_statuses(expected)

        def _matches(payload: Any) -> bool:
            status = _turn_status(payload, turn_id)
            if not isinstance(status, str):
                return False
            return status.strip().lower() in expected_statuses

        detail = await self.until(
            lambda: self._sessions.get(session_id=session_id),
            predicate=_matches,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
            description=(
                f"turn {turn_id} status in {', '.join(sorted(expected_statuses))}"
            ),
        )
        return _turn_status(detail, turn_id)

    async def send_message_and_wait_reply(
        self,
        *,
        session_id: str,
        text: str,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        **send_kwargs: Any,
    ) -> SessionTurnReply:
        accepted = await self._sessions.send_message(
            session_id=session_id, text=text, **send_kwargs
        )
        if not isinstance(accepted, dict):
            raise ValueError(
                "sessions.send_message returned unexpected payload; expected dict with turnId"
            )
        turn_id = accepted.get("turnId")
        if not isinstance(turn_id, str) or not turn_id.strip():
            raise ValueError("sessions.send_message response missing turnId")

        waited = await self.assistant_reply(
            session_id=session_id,
            turn_id=turn_id,
            timeout_seconds=timeout_seconds,
            interval_seconds=interval_seconds,
        )
        return SessionTurnReply(
            session_id=session_id,
            turn_id=turn_id,
            accepted=accepted,
            detail=waited.detail,
            assistant_reply=waited.assistant_reply,
        )
