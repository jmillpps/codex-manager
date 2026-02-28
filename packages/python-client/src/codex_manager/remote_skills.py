"""Session-scoped remote-skill helpers for Python automation flows."""

from __future__ import annotations

import inspect
import json
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable, Iterator

from .models import AppServerSignal

RemoteSkillHandler = Callable[..., Any | Awaitable[Any]]


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


@dataclass(slots=True)
class _SkillRegistry:
    skills: dict[str, RemoteSkill] = field(default_factory=dict)


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


def _tool_call_response_error(response: Any) -> str | None:
    if not isinstance(response, dict):
        return None
    status = response.get("status")
    if status is None or status == "ok":
        return None
    return f"tool call response rejected by codex-manager with status={status}"


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
        if skill.input_schema is not None:
            schema = json.dumps(skill.input_schema, ensure_ascii=True, sort_keys=True)
            lines.append(f"  input_schema: {schema}")
    return "\n".join(lines)


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

    def list(self) -> list[RemoteSkill]:
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
            input_schema=input_schema,
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
            skill_name = name or getattr(handler, "__name__", "remote_skill")
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
    ) -> Iterator["RemoteSkillSession"]:
        self.register(name, handler, description=description, input_schema=input_schema)
        try:
            yield self
        finally:
            self.unregister(name)

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
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
                raise TypeError(
                    f"remote skill {normalized_tool} returned awaitable in sync context; use AsyncCodexManager"
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
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None
        return self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )

    def respond_to_signal(self, signal: AppServerSignal) -> RemoteSkillDispatch | None:
        dispatched = self.dispatch_app_server_signal(signal)
        if dispatched is None:
            return None
        if dispatched.request_id is None:
            return dispatched
        response = self._client.tool_calls.respond(
            request_id=str(dispatched.request_id),
            response=dispatched.response_payload,
        )
        response_error = _tool_call_response_error(response)
        if response_error is not None:
            dispatched.handled = False
            dispatched.error = response_error
        return dispatched


class AsyncRemoteSkillSession:
    """Async session-scoped remote-skill registry and request helper."""

    def __init__(self, *, client: Any, session_id: str, registry: _SkillRegistry) -> None:
        self._client = client
        self.session_id = session_id
        self._registry = registry

    def list(self) -> list[RemoteSkill]:
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
            input_schema=input_schema,
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
            skill_name = name or getattr(handler, "__name__", "remote_skill")
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
    ) -> AsyncIterator["AsyncRemoteSkillSession"]:
        self.register(name, handler, description=description, input_schema=input_schema)
        try:
            yield self
        finally:
            self.unregister(name)

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    async def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
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

    async def dispatch_app_server_signal(self, signal: AppServerSignal) -> RemoteSkillDispatch | None:
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None
        return await self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )

    async def respond_to_signal(self, signal: AppServerSignal) -> RemoteSkillDispatch | None:
        dispatched = await self.dispatch_app_server_signal(signal)
        if dispatched is None:
            return None
        if dispatched.request_id is None:
            return dispatched
        response = await self._client.tool_calls.respond(
            request_id=str(dispatched.request_id),
            response=dispatched.response_payload,
        )
        response_error = _tool_call_response_error(response)
        if response_error is not None:
            dispatched.handled = False
            dispatched.error = response_error
        return dispatched


class RemoteSkillsFacade:
    """Sync remote-skill entrypoint mounted on `CodexManager.remote_skills`."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._registries: dict[str, _SkillRegistry] = {}

    def session(self, session_id: str) -> RemoteSkillSession:
        registry = self._registries.setdefault(session_id, _SkillRegistry())
        return RemoteSkillSession(client=self._client, session_id=session_id, registry=registry)

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
        return AsyncRemoteSkillSession(client=self._client, session_id=session_id, registry=registry)

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
