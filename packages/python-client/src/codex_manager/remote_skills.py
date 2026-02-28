"""Session-scoped remote-skill helpers for Python automation flows."""

from __future__ import annotations

import asyncio
import builtins
import inspect
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from .errors import ApiError
from .models import AppServerSignal

RemoteSkillHandler = Callable[..., Any | Awaitable[Any]]

_DEFAULT_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "additionalProperties": True,
}
_MATERIALIZE_BOOTSTRAP_TEXT = "Reply with exactly OK."
_DEFAULT_RESPONSE_SUBMIT_ATTEMPTS = 3
_DEFAULT_RESPONSE_RETRY_DELAY_SECONDS = 0.05
_MAX_HANDLED_REQUEST_IDS = 4_096


@dataclass(slots=True)
class RemoteSkill:
    """A locally registered callable exposed as a session-scoped remote skill."""

    name: str
    description: str
    handler: RemoteSkillHandler
    input_schema: dict[str, Any] | None = None


@dataclass(slots=True)
class RemoteSkillDispatch:
    """Result for one remote-skill dispatch attempt."""

    handled: bool
    tool: str
    arguments: Any = None
    request_id: str | int | None = None
    call_id: str | None = None
    response_payload: dict[str, Any] | None = None
    result: Any = None
    error: str | None = None
    submission_status: str | None = None
    submission_code: str | None = None
    submission_attempts: int = 0
    submission_idempotent: bool = False


@dataclass(slots=True)
class _SkillRegistry:
    skills: dict[str, RemoteSkill] = field(default_factory=dict)
    handled_request_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _ToolCallSubmission:
    accepted: bool
    retryable: bool
    idempotent: bool = False
    status: str | None = None
    code: str | None = None
    error: str | None = None
    attempts: int = 0


def _normalize_skill_name(name: str) -> str:
    normalized = name.strip()
    if not normalized:
        raise ValueError("remote skill name must be non-empty")
    return normalized


def _invoke_handler(handler: RemoteSkillHandler, arguments: Any) -> Any:
    if isinstance(arguments, dict):
        return handler(**arguments)
    if arguments is None:
        return handler()
    return handler(arguments)


async def _invoke_handler_async(handler: RemoteSkillHandler, arguments: Any) -> Any:
    result = _invoke_handler(handler, arguments)
    if inspect.isawaitable(result):
        return await result
    return result


def _as_output_text(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
    except TypeError:
        return str(value)


def _normalize_response_payload(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        has_content_items = isinstance(result.get("contentItems"), list)
        has_success = isinstance(result.get("success"), bool)
        if has_content_items and has_success:
            return result

    return {
        "contentItems": [{"type": "inputText", "text": _as_output_text(result)}],
        "success": True,
    }


def _error_response_payload(tool: str, error: Exception) -> dict[str, Any]:
    return {
        "contentItems": [{"type": "inputText", "text": f"remote skill {tool} failed: {error}"}],
        "success": False,
    }


def _parse_tool_call_signal(signal: AppServerSignal) -> tuple[str | None, Any, str | None]:
    if signal.event_type != "app_server.request.item.tool.call":
        return None, None, None
    params = signal.params if isinstance(signal.params, dict) else {}
    tool = params.get("tool")
    if not isinstance(tool, str) or tool.strip() == "":
        return None, None, None
    call_id = params.get("callId")
    normalized_call_id = call_id if isinstance(call_id, str) and call_id.strip() else None
    return tool.strip(), params.get("arguments"), normalized_call_id


def _parse_pending_tool_call(record: Any) -> tuple[str | int | None, str | None, Any, str | None]:
    if not isinstance(record, dict):
        return None, None, None, None
    request_id = record.get("requestId")
    if not isinstance(request_id, (str, int)):
        request_id = None
    tool = record.get("tool")
    if not isinstance(tool, str) or tool.strip() == "":
        return request_id, None, record.get("arguments"), None
    call_id = record.get("callId")
    normalized_call_id = call_id if isinstance(call_id, str) and call_id.strip() else None
    return request_id, tool.strip(), record.get("arguments"), normalized_call_id


def _as_non_empty_string(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        if normalized:
            return normalized
    return None


def _to_request_id_string(value: str | int | None) -> str | None:
    if isinstance(value, int):
        return str(value)
    return _as_non_empty_string(value)


def _signal_session_id(signal: AppServerSignal) -> str | None:
    session = signal.session if isinstance(signal.session, dict) else {}
    session_id = _as_non_empty_string(session.get("id"))
    if session_id is not None:
        return session_id

    context = signal.context if isinstance(signal.context, dict) else {}
    return _as_non_empty_string(context.get("threadId"))


def _pending_call_session_id(record: Any) -> str | None:
    if not isinstance(record, dict):
        return None
    return _as_non_empty_string(record.get("threadId"))


def _remember_handled_request(registry: _SkillRegistry, request_id: str) -> None:
    registry.handled_request_ids.add(request_id)
    if len(registry.handled_request_ids) > _MAX_HANDLED_REQUEST_IDS:
        registry.handled_request_ids.clear()


def _normalize_retry_settings(
    max_submit_attempts: int, retry_delay_seconds: float
) -> tuple[int, float]:
    attempts = int(max_submit_attempts)
    if attempts < 1:
        attempts = 1
    delay = float(retry_delay_seconds)
    if delay < 0:
        delay = 0.0
    return attempts, delay


def _classify_tool_call_response(response: Any) -> _ToolCallSubmission:
    if not isinstance(response, dict):
        return _ToolCallSubmission(
            accepted=False,
            retryable=True,
            status="malformed",
            error="tool call response rejected by codex-manager with malformed response payload",
        )

    status = _as_non_empty_string(response.get("status"))
    code = _as_non_empty_string(response.get("code"))
    message = _as_non_empty_string(response.get("message"))

    if status is None or status == "ok":
        return _ToolCallSubmission(accepted=True, retryable=False, status=status or "ok", code=code)

    if status == "conflict" and code == "in_flight":
        return _ToolCallSubmission(
            accepted=True,
            retryable=False,
            idempotent=True,
            status=status,
            code=code,
            error="tool call response already in flight",
        )

    if status == "not_found":
        return _ToolCallSubmission(
            accepted=True,
            retryable=False,
            idempotent=True,
            status=status,
            code=code,
            error="tool call already resolved or unavailable",
        )

    if status == "error":
        parts = [f"status={status}"]
        if code:
            parts.append(f"code={code}")
        if message:
            parts.append(f"message={message}")
        return _ToolCallSubmission(
            accepted=False,
            retryable=True,
            status=status,
            code=code,
            error=f"tool call response rejected by codex-manager with {', '.join(parts)}",
        )

    parts = [f"status={status}"]
    if code:
        parts.append(f"code={code}")
    if message:
        parts.append(f"message={message}")
    return _ToolCallSubmission(
        accepted=False,
        retryable=False,
        status=status,
        code=code,
        error=f"tool call response rejected by codex-manager with {', '.join(parts)}",
    )


def _parse_pending_tool_call_rows(payload: Any) -> list[Any]:
    if not isinstance(payload, dict):
        raise ValueError("sessions.tool_calls returned unexpected payload type; expected object")
    rows = payload.get("data")
    if isinstance(rows, list):
        return rows

    # Non-user/system-owned/deleted sessions return non-list payloads by design.
    status = payload.get("status")
    code = payload.get("code")
    if status == "deleted":
        return []
    if status == "error" and code == "system_session":
        return []

    raise ValueError("sessions.tool_calls response missing data list")


def _is_no_rollout_error(error: Exception) -> bool:
    text = str(error).lower()
    if "no rollout found" in text:
        return True

    if isinstance(error, ApiError):
        body = error.details.response_body
        if isinstance(body, dict):
            for key in ("message", "error", "details"):
                value = body.get(key)
                if isinstance(value, str) and "no rollout found" in value.lower():
                    return True
        elif isinstance(body, str) and "no rollout found" in body.lower():
            return True

    return False


def _render_instruction(skills: dict[str, RemoteSkill]) -> str:
    if not skills:
        return ""

    lines = [
        "Session remote skill catalog (Python-managed):",
        "Use these capabilities when relevant and do not invent unknown tools.",
    ]
    for name in sorted(skills):
        skill = skills[name]
        lines.append(f"- {skill.name}: {skill.description}")
        schema = json.dumps(_resolved_input_schema(skill), ensure_ascii=True, sort_keys=True)
        lines.append(f"  input_schema: {schema}")
    return "\n".join(lines)


def _dynamic_tool_definitions(skills: dict[str, RemoteSkill]) -> list[dict[str, Any]]:
    dynamic_tools: list[dict[str, Any]] = []
    for name in sorted(skills):
        skill = skills[name]
        payload: dict[str, Any] = {
            "name": skill.name,
            "description": skill.description,
            "inputSchema": _resolved_input_schema(skill),
        }
        dynamic_tools.append(payload)
    return dynamic_tools


def _resolved_input_schema(skill: RemoteSkill) -> dict[str, Any]:
    if isinstance(skill.input_schema, dict):
        return deepcopy(skill.input_schema)
    return deepcopy(_DEFAULT_INPUT_SCHEMA)


def _inject_instruction(instruction: str, request_text: str) -> str:
    if not instruction:
        return request_text
    return f"{instruction}\n\nUser request:\n{request_text}"


class RemoteSkillSession:
    """Sync session-scoped remote-skill registry and request helper."""

    def __init__(self, *, client: Any, session_id: str, registry: _SkillRegistry) -> None:
        self._client = client
        self.session_id = session_id
        self._registry = registry

    def matches_signal(self, signal: AppServerSignal) -> bool:
        signal_session_id = _signal_session_id(signal)
        return signal_session_id is None or signal_session_id == self.session_id

    def list(self) -> builtins.list[RemoteSkill]:
        return list(self._registry.skills.values())

    def clear(self) -> int:
        count = len(self._registry.skills)
        self._registry.skills.clear()
        return count

    def register(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> RemoteSkill:
        normalized_name = _normalize_skill_name(name)
        skill = RemoteSkill(
            name=normalized_name,
            description=description.strip() or f"Remote skill {normalized_name}",
            handler=handler,
            input_schema=deepcopy(input_schema) if isinstance(input_schema, dict) else None,
        )
        self._registry.skills[normalized_name] = skill
        return skill

    def unregister(self, name: str) -> bool:
        normalized_name = _normalize_skill_name(name)
        return self._registry.skills.pop(normalized_name, None) is not None

    def skill(
        self,
        *,
        name: str | None = None,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> Callable[[RemoteSkillHandler], RemoteSkillHandler]:
        def decorator(handler: RemoteSkillHandler) -> RemoteSkillHandler:
            raw_name = name if name is not None else getattr(handler, "__name__", "remote_skill")
            skill_name = raw_name if isinstance(raw_name, str) else "remote_skill"
            self.register(skill_name, handler, description=description, input_schema=input_schema)
            return handler

        return decorator

    @contextmanager
    def using(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> Iterator[RemoteSkillSession]:
        self.register(name, handler, description=description, input_schema=input_schema)
        try:
            yield self
        finally:
            self.unregister(name)

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    def dynamic_tools(self) -> builtins.list[dict[str, Any]]:
        return _dynamic_tool_definitions(self._registry.skills)

    def sync_runtime(self) -> Any:
        return self._client.sessions.resume(
            session_id=self.session_id, dynamic_tools=self.dynamic_tools()
        )

    def _materialize_if_needed(self, *, timeout_seconds: float) -> None:
        detail = self._client.sessions.get(session_id=self.session_id)
        session = detail.get("session") if isinstance(detail, dict) else {}
        materialized = session.get("materialized") if isinstance(session, dict) else None
        if materialized is not False:
            return

        accepted = self._client.sessions.send_message(
            session_id=self.session_id, text=_MATERIALIZE_BOOTSTRAP_TEXT
        )
        if isinstance(accepted, dict):
            turn_id = accepted.get("turnId")
            if isinstance(turn_id, str) and turn_id.strip():
                self._client.wait.assistant_reply(
                    session_id=self.session_id,
                    turn_id=turn_id,
                    timeout_seconds=timeout_seconds,
                    interval_seconds=0.25,
                )

        try:
            self._client.sessions.rollback(session_id=self.session_id, num_turns=1)
        except Exception:
            # Rollback is best-effort cleanup; remote-skill catalog readiness does not depend on it.
            pass

    def prepare_catalog(self, *, timeout_seconds: float = 90.0) -> Any:
        dynamic_tools = self.dynamic_tools()
        if not dynamic_tools:
            return {"status": "noop", "sessionId": self.session_id}

        detail = self._client.sessions.get(session_id=self.session_id)
        session = detail.get("session") if isinstance(detail, dict) else {}
        materialized = session.get("materialized") if isinstance(session, dict) else None
        if materialized is False:
            self._materialize_if_needed(timeout_seconds=timeout_seconds)

        try:
            return self._client.sessions.resume(
                session_id=self.session_id, dynamic_tools=dynamic_tools
            )
        except Exception as error:
            if not _is_no_rollout_error(error):
                raise

        self._materialize_if_needed(timeout_seconds=timeout_seconds)
        return self._client.sessions.resume(session_id=self.session_id, dynamic_tools=dynamic_tools)

    def send_prepared(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        prepare_timeout_seconds: float = 90.0,
        **kwargs: Any,
    ) -> Any:
        self.prepare_catalog(timeout_seconds=prepare_timeout_seconds)
        return self.send(request_text, inject_skills=inject_skills, **kwargs)

    def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
        if "dynamic_tools" not in kwargs:
            kwargs["dynamic_tools"] = self.dynamic_tools()
        payload = self.inject_request(request_text) if inject_skills else request_text
        return self._client.sessions.send_message(
            session_id=self.session_id,
            text=payload,
            **kwargs,
        )

    def dispatch_tool_call(
        self,
        *,
        tool: str,
        arguments: Any = None,
        request_id: str | int | None = None,
        call_id: str | None = None,
    ) -> RemoteSkillDispatch:
        normalized_tool = _normalize_skill_name(tool)
        skill = self._registry.skills.get(normalized_tool)
        if skill is None:
            missing_message = f"no remote skill registered for {normalized_tool}"
            return RemoteSkillDispatch(
                handled=False,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload={
                    "contentItems": [{"type": "inputText", "text": missing_message}],
                    "success": False,
                },
                error=missing_message,
            )

        try:
            result = _invoke_handler(skill.handler, arguments)
            if inspect.isawaitable(result):
                close = getattr(result, "close", None)
                if callable(close):
                    close()
                raise TypeError(
                    "remote skill "
                    f"{normalized_tool} returned awaitable in sync context; use AsyncCodexManager"
                )
            response_payload = _normalize_response_payload(result)
            return RemoteSkillDispatch(
                handled=True,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload=response_payload,
                result=result,
            )
        except Exception as error:
            return RemoteSkillDispatch(
                handled=False,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload=_error_response_payload(normalized_tool, error),
                error=str(error),
            )

    def dispatch_app_server_signal(self, signal: AppServerSignal) -> RemoteSkillDispatch | None:
        if not self.matches_signal(signal):
            return None
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None
        return self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )

    def _submit_tool_call_response(
        self,
        request_id: str,
        response_payload: dict[str, Any] | None,
        *,
        max_submit_attempts: int,
        retry_delay_seconds: float,
    ) -> _ToolCallSubmission:
        attempts, retry_delay = _normalize_retry_settings(max_submit_attempts, retry_delay_seconds)
        last_submission: _ToolCallSubmission | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = self._client.tool_calls.respond(
                    request_id=request_id,
                    response=response_payload,
                )
            except Exception as error:
                if attempt < attempts:
                    if retry_delay > 0:
                        time.sleep(retry_delay * attempt)
                    continue
                return _ToolCallSubmission(
                    accepted=False,
                    retryable=False,
                    status="exception",
                    error=f"tool call response submit failed: {error}",
                    attempts=attempt,
                )

            submission = _classify_tool_call_response(response)
            submission.attempts = attempt
            last_submission = submission
            if submission.accepted:
                return submission
            if submission.retryable and attempt < attempts:
                if retry_delay > 0:
                    time.sleep(retry_delay * attempt)
                continue
            return submission

        return last_submission or _ToolCallSubmission(
            accepted=False,
            retryable=False,
            status="error",
            error="tool call response submission exhausted without result",
            attempts=attempts,
        )

    def _finalize_submitted_dispatch(
        self,
        dispatched: RemoteSkillDispatch,
        submission: _ToolCallSubmission,
        *,
        request_id: str,
    ) -> RemoteSkillDispatch:
        dispatched.submission_status = submission.status
        dispatched.submission_code = submission.code
        dispatched.submission_attempts = submission.attempts
        dispatched.submission_idempotent = submission.idempotent
        if submission.accepted:
            _remember_handled_request(self._registry, request_id)
            return dispatched
        dispatched.handled = False
        dispatched.error = submission.error or "tool call response submission failed"
        return dispatched

    def respond_to_signal(
        self,
        signal: AppServerSignal,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> RemoteSkillDispatch | None:
        dispatched = self.dispatch_app_server_signal(signal)
        if dispatched is None:
            return None
        request_id = _to_request_id_string(dispatched.request_id)
        if request_id is None:
            dispatched.submission_status = "no_request_id"
            return dispatched
        if request_id in self._registry.handled_request_ids:
            dispatched.submission_status = "local_duplicate"
            dispatched.submission_idempotent = True
            return dispatched
        submission = self._submit_tool_call_response(
            request_id,
            dispatched.response_payload,
            max_submit_attempts=max_submit_attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        return self._finalize_submitted_dispatch(dispatched, submission, request_id=request_id)

    def respond_to_pending_call(
        self,
        pending_call: Any,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> RemoteSkillDispatch | None:
        pending_session_id = _pending_call_session_id(pending_call)
        if pending_session_id is not None and pending_session_id != self.session_id:
            return None
        request_id, tool, arguments, call_id = _parse_pending_tool_call(pending_call)
        if tool is None:
            return None
        dispatched = self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=request_id,
            call_id=call_id,
        )
        request_id_normalized = _to_request_id_string(dispatched.request_id)
        if request_id_normalized is None:
            dispatched.submission_status = "no_request_id"
            return dispatched
        if request_id_normalized in self._registry.handled_request_ids:
            dispatched.submission_status = "local_duplicate"
            dispatched.submission_idempotent = True
            return dispatched
        submission = self._submit_tool_call_response(
            request_id_normalized,
            dispatched.response_payload,
            max_submit_attempts=max_submit_attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        return self._finalize_submitted_dispatch(
            dispatched, submission, request_id=request_id_normalized
        )

    def drain_pending_calls(
        self,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> builtins.list[RemoteSkillDispatch]:
        payload = self._client.sessions.tool_calls(session_id=self.session_id)
        rows = _parse_pending_tool_call_rows(payload)
        dispatches: builtins.list[RemoteSkillDispatch] = []
        for row in rows:
            dispatched = self.respond_to_pending_call(
                row,
                max_submit_attempts=max_submit_attempts,
                retry_delay_seconds=retry_delay_seconds,
            )
            if dispatched is not None:
                dispatches.append(dispatched)
        return dispatches


class AsyncRemoteSkillSession:
    """Async session-scoped remote-skill registry and request helper."""

    def __init__(self, *, client: Any, session_id: str, registry: _SkillRegistry) -> None:
        self._client = client
        self.session_id = session_id
        self._registry = registry

    def matches_signal(self, signal: AppServerSignal) -> bool:
        signal_session_id = _signal_session_id(signal)
        return signal_session_id is None or signal_session_id == self.session_id

    def list(self) -> builtins.list[RemoteSkill]:
        return list(self._registry.skills.values())

    def clear(self) -> int:
        count = len(self._registry.skills)
        self._registry.skills.clear()
        return count

    def register(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> RemoteSkill:
        normalized_name = _normalize_skill_name(name)
        skill = RemoteSkill(
            name=normalized_name,
            description=description.strip() or f"Remote skill {normalized_name}",
            handler=handler,
            input_schema=deepcopy(input_schema) if isinstance(input_schema, dict) else None,
        )
        self._registry.skills[normalized_name] = skill
        return skill

    def unregister(self, name: str) -> bool:
        normalized_name = _normalize_skill_name(name)
        return self._registry.skills.pop(normalized_name, None) is not None

    def skill(
        self,
        *,
        name: str | None = None,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> Callable[[RemoteSkillHandler], RemoteSkillHandler]:
        def decorator(handler: RemoteSkillHandler) -> RemoteSkillHandler:
            raw_name = name if name is not None else getattr(handler, "__name__", "remote_skill")
            skill_name = raw_name if isinstance(raw_name, str) else "remote_skill"
            self.register(skill_name, handler, description=description, input_schema=input_schema)
            return handler

        return decorator

    @asynccontextmanager
    async def using(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> AsyncIterator[AsyncRemoteSkillSession]:
        self.register(name, handler, description=description, input_schema=input_schema)
        try:
            yield self
        finally:
            self.unregister(name)

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    def dynamic_tools(self) -> builtins.list[dict[str, Any]]:
        return _dynamic_tool_definitions(self._registry.skills)

    async def sync_runtime(self) -> Any:
        return await self._client.sessions.resume(
            session_id=self.session_id, dynamic_tools=self.dynamic_tools()
        )

    async def _materialize_if_needed(self, *, timeout_seconds: float) -> None:
        detail = await self._client.sessions.get(session_id=self.session_id)
        session = detail.get("session") if isinstance(detail, dict) else {}
        materialized = session.get("materialized") if isinstance(session, dict) else None
        if materialized is not False:
            return

        accepted = await self._client.sessions.send_message(
            session_id=self.session_id, text=_MATERIALIZE_BOOTSTRAP_TEXT
        )
        if isinstance(accepted, dict):
            turn_id = accepted.get("turnId")
            if isinstance(turn_id, str) and turn_id.strip():
                await self._client.wait.assistant_reply(
                    session_id=self.session_id,
                    turn_id=turn_id,
                    timeout_seconds=timeout_seconds,
                    interval_seconds=0.25,
                )

        try:
            await self._client.sessions.rollback(session_id=self.session_id, num_turns=1)
        except Exception:
            # Rollback is best-effort cleanup; remote-skill catalog readiness does not depend on it.
            pass

    async def prepare_catalog(self, *, timeout_seconds: float = 90.0) -> Any:
        dynamic_tools = self.dynamic_tools()
        if not dynamic_tools:
            return {"status": "noop", "sessionId": self.session_id}

        detail = await self._client.sessions.get(session_id=self.session_id)
        session = detail.get("session") if isinstance(detail, dict) else {}
        materialized = session.get("materialized") if isinstance(session, dict) else None
        if materialized is False:
            await self._materialize_if_needed(timeout_seconds=timeout_seconds)

        try:
            return await self._client.sessions.resume(
                session_id=self.session_id, dynamic_tools=dynamic_tools
            )
        except Exception as error:
            if not _is_no_rollout_error(error):
                raise

        await self._materialize_if_needed(timeout_seconds=timeout_seconds)
        return await self._client.sessions.resume(
            session_id=self.session_id, dynamic_tools=dynamic_tools
        )

    async def send_prepared(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        prepare_timeout_seconds: float = 90.0,
        **kwargs: Any,
    ) -> Any:
        await self.prepare_catalog(timeout_seconds=prepare_timeout_seconds)
        return await self.send(request_text, inject_skills=inject_skills, **kwargs)

    async def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
        if "dynamic_tools" not in kwargs:
            kwargs["dynamic_tools"] = self.dynamic_tools()
        payload = self.inject_request(request_text) if inject_skills else request_text
        return await self._client.sessions.send_message(
            session_id=self.session_id,
            text=payload,
            **kwargs,
        )

    async def dispatch_tool_call(
        self,
        *,
        tool: str,
        arguments: Any = None,
        request_id: str | int | None = None,
        call_id: str | None = None,
    ) -> RemoteSkillDispatch:
        normalized_tool = _normalize_skill_name(tool)
        skill = self._registry.skills.get(normalized_tool)
        if skill is None:
            missing_message = f"no remote skill registered for {normalized_tool}"
            return RemoteSkillDispatch(
                handled=False,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload={
                    "contentItems": [{"type": "inputText", "text": missing_message}],
                    "success": False,
                },
                error=missing_message,
            )

        try:
            result = await _invoke_handler_async(skill.handler, arguments)
            response_payload = _normalize_response_payload(result)
            return RemoteSkillDispatch(
                handled=True,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload=response_payload,
                result=result,
            )
        except Exception as error:
            return RemoteSkillDispatch(
                handled=False,
                tool=normalized_tool,
                arguments=arguments,
                request_id=request_id,
                call_id=call_id,
                response_payload=_error_response_payload(normalized_tool, error),
                error=str(error),
            )

    async def dispatch_app_server_signal(
        self, signal: AppServerSignal
    ) -> RemoteSkillDispatch | None:
        if not self.matches_signal(signal):
            return None
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None
        return await self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )

    async def _submit_tool_call_response(
        self,
        request_id: str,
        response_payload: dict[str, Any] | None,
        *,
        max_submit_attempts: int,
        retry_delay_seconds: float,
    ) -> _ToolCallSubmission:
        attempts, retry_delay = _normalize_retry_settings(max_submit_attempts, retry_delay_seconds)
        last_submission: _ToolCallSubmission | None = None
        for attempt in range(1, attempts + 1):
            try:
                response = await self._client.tool_calls.respond(
                    request_id=request_id,
                    response=response_payload,
                )
            except Exception as error:
                if attempt < attempts:
                    if retry_delay > 0:
                        await asyncio.sleep(retry_delay * attempt)
                    continue
                return _ToolCallSubmission(
                    accepted=False,
                    retryable=False,
                    status="exception",
                    error=f"tool call response submit failed: {error}",
                    attempts=attempt,
                )

            submission = _classify_tool_call_response(response)
            submission.attempts = attempt
            last_submission = submission
            if submission.accepted:
                return submission
            if submission.retryable and attempt < attempts:
                if retry_delay > 0:
                    await asyncio.sleep(retry_delay * attempt)
                continue
            return submission

        return last_submission or _ToolCallSubmission(
            accepted=False,
            retryable=False,
            status="error",
            error="tool call response submission exhausted without result",
            attempts=attempts,
        )

    def _finalize_submitted_dispatch(
        self,
        dispatched: RemoteSkillDispatch,
        submission: _ToolCallSubmission,
        *,
        request_id: str,
    ) -> RemoteSkillDispatch:
        dispatched.submission_status = submission.status
        dispatched.submission_code = submission.code
        dispatched.submission_attempts = submission.attempts
        dispatched.submission_idempotent = submission.idempotent
        if submission.accepted:
            _remember_handled_request(self._registry, request_id)
            return dispatched
        dispatched.handled = False
        dispatched.error = submission.error or "tool call response submission failed"
        return dispatched

    async def respond_to_signal(
        self,
        signal: AppServerSignal,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> RemoteSkillDispatch | None:
        dispatched = await self.dispatch_app_server_signal(signal)
        if dispatched is None:
            return None
        request_id = _to_request_id_string(dispatched.request_id)
        if request_id is None:
            dispatched.submission_status = "no_request_id"
            return dispatched
        if request_id in self._registry.handled_request_ids:
            dispatched.submission_status = "local_duplicate"
            dispatched.submission_idempotent = True
            return dispatched
        submission = await self._submit_tool_call_response(
            request_id,
            dispatched.response_payload,
            max_submit_attempts=max_submit_attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        return self._finalize_submitted_dispatch(dispatched, submission, request_id=request_id)

    async def respond_to_pending_call(
        self,
        pending_call: Any,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> RemoteSkillDispatch | None:
        pending_session_id = _pending_call_session_id(pending_call)
        if pending_session_id is not None and pending_session_id != self.session_id:
            return None
        request_id, tool, arguments, call_id = _parse_pending_tool_call(pending_call)
        if tool is None:
            return None
        dispatched = await self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=request_id,
            call_id=call_id,
        )
        request_id_normalized = _to_request_id_string(dispatched.request_id)
        if request_id_normalized is None:
            dispatched.submission_status = "no_request_id"
            return dispatched
        if request_id_normalized in self._registry.handled_request_ids:
            dispatched.submission_status = "local_duplicate"
            dispatched.submission_idempotent = True
            return dispatched
        submission = await self._submit_tool_call_response(
            request_id_normalized,
            dispatched.response_payload,
            max_submit_attempts=max_submit_attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        return self._finalize_submitted_dispatch(
            dispatched, submission, request_id=request_id_normalized
        )

    async def drain_pending_calls(
        self,
        *,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
    ) -> builtins.list[RemoteSkillDispatch]:
        payload = await self._client.sessions.tool_calls(session_id=self.session_id)
        rows = _parse_pending_tool_call_rows(payload)
        dispatches: builtins.list[RemoteSkillDispatch] = []
        for row in rows:
            dispatched = await self.respond_to_pending_call(
                row,
                max_submit_attempts=max_submit_attempts,
                retry_delay_seconds=retry_delay_seconds,
            )
            if dispatched is not None:
                dispatches.append(dispatched)
        return dispatches


class RemoteSkillsFacade:
    """Sync remote-skill entrypoint mounted on `CodexManager.remote_skills`."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._registries: dict[str, _SkillRegistry] = {}

    def session(self, session_id: str) -> RemoteSkillSession:
        registry = self._registries.setdefault(session_id, _SkillRegistry())
        return RemoteSkillSession(client=self._client, session_id=session_id, registry=registry)

    def create_session(
        self,
        *,
        register: Callable[[RemoteSkillSession], None] | None = None,
        **create_kwargs: Any,
    ) -> tuple[Any, RemoteSkillSession]:
        registry = _SkillRegistry()
        draft = RemoteSkillSession(client=self._client, session_id="draft", registry=registry)
        if register is not None:
            registered = register(draft)
            if inspect.isawaitable(registered):
                close = getattr(registered, "close", None)
                if callable(close):
                    close()
                raise TypeError(
                    "remote_skills.create_session register callback must be sync; "
                    "use AsyncCodexManager"
                )

        dynamic_tools = draft.dynamic_tools()
        if dynamic_tools and "dynamic_tools" not in create_kwargs:
            create_kwargs["dynamic_tools"] = dynamic_tools
        created = self._client.sessions.create(**create_kwargs)

        session_payload = created.get("session") if isinstance(created, dict) else None
        session_id = session_payload.get("sessionId") if isinstance(session_payload, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("sessions.create response missing session.sessionId")

        bound = self.session(session_id)
        bound._registry.skills = dict(registry.skills)
        return created, bound

    @contextmanager
    def using(
        self,
        session_id: str,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> Iterator[RemoteSkillSession]:
        session = self.session(session_id)
        with session.using(name, handler, description=description, input_schema=input_schema):
            yield session


class AsyncRemoteSkillsFacade:
    """Async remote-skill entrypoint mounted on `AsyncCodexManager.remote_skills`."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._registries: dict[str, _SkillRegistry] = {}

    def session(self, session_id: str) -> AsyncRemoteSkillSession:
        registry = self._registries.setdefault(session_id, _SkillRegistry())
        return AsyncRemoteSkillSession(
            client=self._client, session_id=session_id, registry=registry
        )

    async def create_session(
        self,
        *,
        register: Callable[[AsyncRemoteSkillSession], None | Awaitable[None]] | None = None,
        **create_kwargs: Any,
    ) -> tuple[Any, AsyncRemoteSkillSession]:
        registry = _SkillRegistry()
        draft = AsyncRemoteSkillSession(client=self._client, session_id="draft", registry=registry)
        if register is not None:
            registered = register(draft)
            if inspect.isawaitable(registered):
                await registered

        dynamic_tools = draft.dynamic_tools()
        if dynamic_tools and "dynamic_tools" not in create_kwargs:
            create_kwargs["dynamic_tools"] = dynamic_tools
        created = await self._client.sessions.create(**create_kwargs)

        session_payload = created.get("session") if isinstance(created, dict) else None
        session_id = session_payload.get("sessionId") if isinstance(session_payload, dict) else None
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("sessions.create response missing session.sessionId")

        bound = self.session(session_id)
        bound._registry.skills = dict(registry.skills)
        return created, bound

    @asynccontextmanager
    async def using(
        self,
        session_id: str,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str,
        input_schema: dict[str, Any] | None = None,
    ) -> AsyncIterator[AsyncRemoteSkillSession]:
        session = self.session(session_id)
        async with session.using(name, handler, description=description, input_schema=input_schema):
            yield session
