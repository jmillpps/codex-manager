"""Session-scoped remote-skill helpers for Python automation flows."""

from __future__ import annotations

import asyncio
import builtins
import dataclasses
import inspect
import json
import sys
import time
import types
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from enum import Enum
from typing import (
    Annotated,
    Any,
    ClassVar,
    Literal,
    NotRequired,
    NoReturn,
    Required,
    Union,
    get_args,
    get_origin,
    get_type_hints,
    is_typeddict,
)

from docstring_parser import parse as parse_docstring

from .errors import ApiError, WaitTimeoutError
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
_MAX_SCHEMA_INFER_DEPTH = 12
_DISPATCH_MODE_SIGNAL = "signal"
_DISPATCH_MODE_POLLING = "polling"
_CATALOG_MUTATION_ERROR = (
    "remote skill catalog mutation is create-time only. "
    "Register skills in remote_skills.create_session(register=...) "
    "or remote_skills.lifecycle(register=...)."
)
_RUNTIME_SYNC_DISABLED_ERROR = (
    "runtime catalog sync is disabled for reliability. "
    "Register skills at session creation."
)
_DEFAULT_TERMINAL_TURN_STATUSES: tuple[str, ...] = (
    "completed",
    "complete",
    "failed",
    "error",
    "interrupted",
    "canceled",
    "cancelled",
)


@dataclass(slots=True)
class RemoteSkill:
    """A locally registered callable exposed as a session-scoped remote skill."""

    name: str
    description: str
    handler: RemoteSkillHandler
    input_schema: dict[str, Any] | None = None
    output_schema: dict[str, Any] | None = None
    output_description: str | None = None


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
class RemoteSkillSendResult:
    """Result payload for send+dispatch+wait remote-skill helpers."""

    session_id: str
    turn_id: str
    accepted: Any
    detail: Any
    status: str | None
    assistant_reply: str | None
    dispatches: builtins.list[RemoteSkillDispatch]


@dataclass(slots=True)
class RemoteSkillLifecycle:
    """Handle for a managed sync remote-skill session lifecycle."""

    session_id: str
    created: Any
    skills: RemoteSkillSession


@dataclass(slots=True)
class AsyncRemoteSkillLifecycle:
    """Handle for a managed async remote-skill session lifecycle."""

    session_id: str
    created: Any
    skills: AsyncRemoteSkillSession


@dataclass(slots=True)
class _SkillRegistry:
    skills: dict[str, RemoteSkill] = field(default_factory=dict)
    handled_request_ids: set[str] = field(default_factory=set)
    dispatch_mode: str | None = None
    catalog_locked: bool = False


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


def _literal_json_type(values: Iterable[Any]) -> str | None:
    kinds: set[str] = set()
    for value in values:
        if isinstance(value, bool):
            kinds.add("boolean")
        elif isinstance(value, int):
            kinds.add("integer")
        elif isinstance(value, float):
            kinds.add("number")
        elif isinstance(value, str):
            kinds.add("string")
        else:
            return None

    if len(kinds) == 1:
        return next(iter(kinds))
    if kinds == {"integer", "number"}:
        return "number"
    return None


def _target_globalns(target: Any) -> dict[str, Any] | None:
    function_globals = getattr(target, "__globals__", None)
    if isinstance(function_globals, dict):
        return function_globals

    module_name = getattr(target, "__module__", None)
    if isinstance(module_name, str) and module_name:
        module = sys.modules.get(module_name)
        if module is not None:
            module_globals = getattr(module, "__dict__", None)
            if isinstance(module_globals, dict):
                return module_globals
    return None


def _class_localns(annotation: type[Any]) -> dict[str, Any]:
    localns: dict[str, Any] = {annotation.__name__: annotation}
    class_dict = getattr(annotation, "__dict__", None)
    if isinstance(class_dict, Mapping):
        localns.update(dict(class_dict))
    return localns


def _resolve_string_annotation(
    annotation: Any,
    *,
    globalns: dict[str, Any] | None,
    localns: dict[str, Any] | None,
) -> Any:
    if not isinstance(annotation, str):
        return annotation

    normalized = annotation.strip()
    if not normalized:
        return annotation

    if isinstance(localns, dict):
        candidate = localns.get(normalized)
        if candidate is not None:
            return candidate

    if isinstance(globalns, dict):
        candidate = globalns.get(normalized)
        if candidate is not None:
            return candidate

    if normalized == "Any":
        return Any
    if normalized == "None":
        return type(None)

    if hasattr(builtins, normalized):
        return getattr(builtins, normalized)

    return annotation


def _safe_type_hints(
    target: Any,
    *,
    globalns: dict[str, Any] | None = None,
    localns: dict[str, Any] | None = None,
) -> dict[str, Any]:
    resolved_globalns = globalns if isinstance(globalns, dict) else _target_globalns(target)
    try:
        return get_type_hints(
            target,
            globalns=resolved_globalns,
            localns=localns,
            include_extras=True,
        )
    except Exception:
        return {}


def _is_classvar_annotation(annotation: Any) -> bool:
    return get_origin(annotation) is ClassVar


def _annotation_to_json_schema(annotation: Any) -> dict[str, Any]:
    return _annotation_to_json_schema_recursive(annotation, depth=0, seen=set())


def _schema_from_constructor_signature(
    annotation: type[Any],
    *,
    depth: int,
    seen: set[int],
) -> dict[str, Any] | None:
    init = getattr(annotation, "__init__", None)
    if not callable(init) or init is object.__init__:
        return None

    try:
        signature = inspect.signature(init)
    except Exception:
        return None

    localns = _class_localns(annotation)
    globalns = _target_globalns(init)
    hints = _safe_type_hints(init, globalns=globalns, localns=localns)
    properties: dict[str, Any] = {}
    required: list[str] = []
    additional_properties = False

    for parameter in signature.parameters.values():
        if parameter.name == "self":
            continue
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            continue
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            additional_properties = True
            continue

        parameter_annotation = hints.get(parameter.name, parameter.annotation)
        parameter_annotation = _resolve_string_annotation(
            parameter_annotation,
            globalns=globalns,
            localns=localns,
        )
        if _is_classvar_annotation(parameter_annotation):
            continue
        properties[parameter.name] = _annotation_to_json_schema_recursive(
            parameter_annotation, depth=depth + 1, seen=seen
        )
        if parameter.default is inspect._empty:
            required.append(parameter.name)

    if not properties and not additional_properties:
        return None

    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional_properties,
    }
    if required:
        schema["required"] = required
    return schema


def _schema_from_class_annotations(
    annotation: type[Any],
    *,
    depth: int,
    seen: set[int],
) -> dict[str, Any] | None:
    annotations = getattr(annotation, "__annotations__", None)
    if not isinstance(annotations, dict) or not annotations:
        return None

    localns = _class_localns(annotation)
    globalns = _target_globalns(annotation)
    hints = _safe_type_hints(annotation, globalns=globalns, localns=localns)
    properties: dict[str, Any] = {}
    required: list[str] = []

    for field_name, raw_annotation in annotations.items():
        if not isinstance(field_name, str) or not field_name or field_name.startswith("_"):
            continue
        field_annotation = hints.get(field_name, raw_annotation)
        field_annotation = _resolve_string_annotation(
            field_annotation,
            globalns=globalns,
            localns=localns,
        )
        if _is_classvar_annotation(field_annotation):
            continue
        properties[field_name] = _annotation_to_json_schema_recursive(
            field_annotation, depth=depth + 1, seen=seen
        )
        has_default = hasattr(annotation, field_name)
        if not has_default:
            required.append(field_name)

    if not properties:
        return None

    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": False,
    }
    if required:
        schema["required"] = required
    return schema


def _annotation_to_json_schema_recursive(
    annotation: Any,
    *,
    depth: int,
    seen: set[int],
) -> dict[str, Any]:
    if depth > _MAX_SCHEMA_INFER_DEPTH:
        return {"type": "object"}

    if annotation is inspect._empty or annotation is Any:
        return {}
    if annotation is None or annotation is type(None):
        return {"nullable": True}

    origin = get_origin(annotation)
    if origin is Annotated:
        args = get_args(annotation)
        return _annotation_to_json_schema_recursive(args[0], depth=depth + 1, seen=seen) if args else {}

    if origin in (Required, NotRequired):
        args = get_args(annotation)
        return _annotation_to_json_schema_recursive(args[0], depth=depth + 1, seen=seen) if args else {}

    if origin in (Union, types.UnionType):
        args = list(get_args(annotation))
        nullable = any(arg in (None, type(None)) for arg in args)
        non_none = [arg for arg in args if arg not in (None, type(None))]
        if len(non_none) == 1:
            schema = _annotation_to_json_schema_recursive(non_none[0], depth=depth + 1, seen=seen)
            if nullable:
                schema = dict(schema)
                schema["nullable"] = True
            return schema

        branch_schemas = [
            (_annotation_to_json_schema_recursive(arg, depth=depth + 1, seen=seen) or {})
            for arg in non_none
        ]
        schema: dict[str, Any] = {}
        if branch_schemas:
            schema["anyOf"] = branch_schemas
        if nullable:
            schema["nullable"] = True
        return schema

    if origin is Literal:
        values = list(get_args(annotation))
        schema: dict[str, Any] = {"enum": values}
        literal_type = _literal_json_type(values)
        if literal_type is not None:
            schema["type"] = literal_type
        return schema

    if origin in (list, builtins.list, set, builtins.set, frozenset, Sequence):
        args = get_args(annotation)
        item_schema = (
            _annotation_to_json_schema_recursive(args[0], depth=depth + 1, seen=seen) if args else {}
        )
        schema: dict[str, Any] = {"type": "array"}
        if item_schema:
            schema["items"] = item_schema
        return schema

    if origin in (tuple, builtins.tuple):
        args = [arg for arg in get_args(annotation) if arg is not Ellipsis]
        item_schema: dict[str, Any] = {}
        if args:
            if len(args) == 1:
                item_schema = _annotation_to_json_schema_recursive(args[0], depth=depth + 1, seen=seen)
            else:
                item_schema = {
                    "anyOf": [
                        (_annotation_to_json_schema_recursive(arg, depth=depth + 1, seen=seen) or {})
                        for arg in args
                    ]
                }
        schema: dict[str, Any] = {"type": "array"}
        if item_schema:
            schema["items"] = item_schema
        return schema

    if origin in (dict, builtins.dict, Mapping):
        args = get_args(annotation)
        value_schema = (
            _annotation_to_json_schema_recursive(args[1], depth=depth + 1, seen=seen)
            if len(args) >= 2
            else {}
        )
        schema = {"type": "object"}
        if value_schema:
            schema["additionalProperties"] = value_schema
        return schema

    if inspect.isclass(annotation):
        annotation_id = id(annotation)
        if annotation_id in seen:
            return {"type": "object"}

        if issubclass(annotation, Enum):
            values = [member.value for member in annotation]
            schema: dict[str, Any] = {"enum": values}
            enum_type = _literal_json_type(values)
            if enum_type is not None:
                schema["type"] = enum_type
            return schema

        if is_typeddict(annotation):
            seen.add(annotation_id)
            try:
                localns = _class_localns(annotation)
                globalns = _target_globalns(annotation)
                hints = _safe_type_hints(annotation, globalns=globalns, localns=localns)
                annotations = getattr(annotation, "__annotations__", {})
                properties: dict[str, Any] = {}
                required_set = getattr(annotation, "__required_keys__", set(annotations.keys()))
                required: list[str] = []
                for key in annotations.keys():
                    key_annotation = hints.get(key, annotations.get(key, Any))
                    key_annotation = _resolve_string_annotation(
                        key_annotation,
                        globalns=globalns,
                        localns=localns,
                    )
                    required_override: bool | None = None
                    key_origin = get_origin(key_annotation)
                    if key_origin is Required:
                        key_args = get_args(key_annotation)
                        key_annotation = key_args[0] if key_args else Any
                        required_override = True
                    elif key_origin is NotRequired:
                        key_args = get_args(key_annotation)
                        key_annotation = key_args[0] if key_args else Any
                        required_override = False
                    properties[key] = _annotation_to_json_schema_recursive(
                        key_annotation, depth=depth + 1, seen=seen
                    )
                    if required_override is True or (
                        required_override is None and key in required_set
                    ):
                        required.append(key)
                schema: dict[str, Any] = {
                    "type": "object",
                    "properties": properties,
                    "additionalProperties": False,
                }
                if required:
                    schema["required"] = required
                return schema
            finally:
                seen.discard(annotation_id)

        if dataclasses.is_dataclass(annotation):
            seen.add(annotation_id)
            try:
                localns = _class_localns(annotation)
                globalns = _target_globalns(annotation)
                hints = _safe_type_hints(annotation, globalns=globalns, localns=localns)
                properties: dict[str, Any] = {}
                required: list[str] = []
                for data_field in dataclasses.fields(annotation):
                    if not data_field.init:
                        continue
                    field_annotation = hints.get(data_field.name, data_field.type)
                    field_annotation = _resolve_string_annotation(
                        field_annotation,
                        globalns=globalns,
                        localns=localns,
                    )
                    properties[data_field.name] = _annotation_to_json_schema_recursive(
                        field_annotation, depth=depth + 1, seen=seen
                    )
                    has_default = data_field.default is not dataclasses.MISSING
                    has_factory = data_field.default_factory is not dataclasses.MISSING
                    if not has_default and not has_factory:
                        required.append(data_field.name)
                schema: dict[str, Any] = {
                    "type": "object",
                    "properties": properties,
                    "additionalProperties": False,
                }
                if required:
                    schema["required"] = required
                return schema
            finally:
                seen.discard(annotation_id)

        model_json_schema = getattr(annotation, "model_json_schema", None)
        if callable(model_json_schema):
            try:
                model_schema = model_json_schema()
                if isinstance(model_schema, dict):
                    return model_schema
            except Exception:
                pass

        if issubclass(annotation, bool):
            return {"type": "boolean"}
        if issubclass(annotation, int):
            return {"type": "integer"}
        if issubclass(annotation, float):
            return {"type": "number"}
        if issubclass(annotation, str):
            return {"type": "string"}
        if issubclass(annotation, (list, tuple, set, frozenset)):
            return {"type": "array"}
        if issubclass(annotation, dict):
            return {"type": "object"}

        seen.add(annotation_id)
        try:
            constructor_schema = _schema_from_constructor_signature(
                annotation, depth=depth, seen=seen
            )
            if isinstance(constructor_schema, dict):
                return constructor_schema
            annotation_schema = _schema_from_class_annotations(annotation, depth=depth, seen=seen)
            if isinstance(annotation_schema, dict):
                return annotation_schema
        finally:
            seen.discard(annotation_id)
        return {"type": "object"}

    return {}


def _schema_inferred_from_handler(handler: RemoteSkillHandler) -> dict[str, Any] | None:
    try:
        signature = inspect.signature(handler)
    except Exception:
        return None

    globalns = _target_globalns(handler)
    hints = _safe_type_hints(handler, globalns=globalns)

    properties: dict[str, Any] = {}
    required: list[str] = []
    additional_properties = False

    for parameter in signature.parameters.values():
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            continue
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            additional_properties = True
            continue

        annotation = hints.get(parameter.name, parameter.annotation)
        annotation = _resolve_string_annotation(annotation, globalns=globalns, localns=None)
        properties[parameter.name] = _annotation_to_json_schema(annotation)
        if parameter.default is inspect._empty:
            required.append(parameter.name)

    inferred_schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional_properties,
    }
    if required:
        inferred_schema["required"] = required
    return inferred_schema


def _docstring_enrichment(handler: RemoteSkillHandler) -> tuple[str | None, dict[str, str], str | None]:
    raw_docstring = inspect.getdoc(handler)
    if not raw_docstring:
        return None, {}, None

    try:
        parsed = parse_docstring(raw_docstring)
    except Exception:
        return None, {}, None

    summary_parts: list[str] = []
    short_description = getattr(parsed, "short_description", None)
    if isinstance(short_description, str) and short_description.strip():
        summary_parts.append(short_description.strip())

    long_description = getattr(parsed, "long_description", None)
    if isinstance(long_description, str) and long_description.strip():
        summary_parts.append(long_description.strip())

    schema_description = "\n\n".join(summary_parts) if summary_parts else None

    param_descriptions: dict[str, str] = {}
    params = getattr(parsed, "params", None)
    if isinstance(params, list):
        for param in params:
            arg_name = getattr(param, "arg_name", None)
            description = getattr(param, "description", None)
            if not isinstance(arg_name, str):
                continue
            normalized_name = arg_name.strip()
            if not normalized_name:
                continue
            if not isinstance(description, str):
                continue
            normalized_description = description.strip()
            if not normalized_description:
                continue
            param_descriptions[normalized_name] = normalized_description

    return_description: str | None = None
    parsed_returns = getattr(parsed, "returns", None)
    if parsed_returns is not None:
        returns_description = getattr(parsed_returns, "description", None)
        if isinstance(returns_description, str):
            normalized_returns = returns_description.strip()
            if normalized_returns:
                return_description = normalized_returns

    return schema_description, param_descriptions, return_description


def _schema_enriched_with_docstrings(
    handler: RemoteSkillHandler, input_schema: dict[str, Any] | None
) -> dict[str, Any] | None:
    explicit_schema = isinstance(input_schema, dict)
    if explicit_schema:
        schema = deepcopy(input_schema)
    else:
        inferred_schema = _schema_inferred_from_handler(handler)
        if not isinstance(inferred_schema, dict):
            return None
        schema = inferred_schema

    schema_description, param_descriptions, _ = _docstring_enrichment(handler)

    if schema_description:
        existing_description = schema.get("description")
        if not isinstance(existing_description, str) or not existing_description.strip():
            schema["description"] = schema_description

    properties = schema.get("properties")
    if isinstance(properties, dict):
        for name, description in param_descriptions.items():
            property_schema = properties.get(name)
            if not isinstance(property_schema, dict):
                if explicit_schema:
                    # Explicit schemas are authoritative; do not inject undeclared properties.
                    continue
                property_schema = {}
                properties[name] = property_schema
            existing_description = property_schema.get("description")
            if isinstance(existing_description, str) and existing_description.strip():
                continue
            property_schema["description"] = description

    return schema


def _resolved_skill_description(
    *,
    normalized_name: str,
    handler: RemoteSkillHandler,
    description: str | None,
) -> str:
    if isinstance(description, str):
        explicit = description.strip()
        if explicit:
            return explicit
    doc_description, _, _ = _docstring_enrichment(handler)
    if isinstance(doc_description, str):
        inferred = doc_description.strip()
        if inferred:
            return inferred
    return f"Remote skill {normalized_name}"


def _schema_inferred_from_handler_return(handler: RemoteSkillHandler) -> dict[str, Any] | None:
    try:
        signature = inspect.signature(handler)
    except Exception:
        return None

    globalns = _target_globalns(handler)
    hints = _safe_type_hints(handler, globalns=globalns)
    annotation = hints.get("return", signature.return_annotation)
    annotation = _resolve_string_annotation(annotation, globalns=globalns, localns=None)
    if annotation is inspect._empty or annotation is Any:
        return None

    schema = _annotation_to_json_schema(annotation)
    if not isinstance(schema, dict):
        return None
    return schema if schema else None


def _resolved_output_schema(
    handler: RemoteSkillHandler,
    output_schema: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if isinstance(output_schema, dict):
        return deepcopy(output_schema)
    return _schema_inferred_from_handler_return(handler)


def _resolved_output_description(
    handler: RemoteSkillHandler,
    output_schema: dict[str, Any] | None,
) -> str | None:
    if isinstance(output_schema, dict):
        schema_description = output_schema.get("description")
        if isinstance(schema_description, str):
            normalized = schema_description.strip()
            if normalized:
                return normalized

    _, _, return_description = _docstring_enrichment(handler)
    if isinstance(return_description, str):
        normalized = return_description.strip()
        if normalized:
            return normalized
    return None


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


def _delete_response_indicates_deleted(response: Any) -> bool:
    if not isinstance(response, dict):
        return False
    status = _as_non_empty_string(response.get("status"))
    return status in {"ok", "deleted"}


def _remember_handled_request(registry: _SkillRegistry, request_id: str) -> None:
    registry.handled_request_ids.add(request_id)
    if len(registry.handled_request_ids) > _MAX_HANDLED_REQUEST_IDS:
        # Trim while preserving the latest handled request id to keep immediate dedupe intact.
        registry.handled_request_ids.discard(request_id)
        while len(registry.handled_request_ids) >= _MAX_HANDLED_REQUEST_IDS:
            registry.handled_request_ids.pop()
        registry.handled_request_ids.add(request_id)


def _require_catalog_mutation_allowed(registry: _SkillRegistry) -> None:
    if registry.catalog_locked:
        raise RuntimeError(_CATALOG_MUTATION_ERROR)


def _clear_registry_skills(registry: _SkillRegistry) -> int:
    count = len(registry.skills)
    registry.skills.clear()
    return count


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


def _normalize_statuses(values: Iterable[str] | str | None) -> set[str]:
    if values is None:
        source: Iterable[str] = _DEFAULT_TERMINAL_TURN_STATUSES
    elif isinstance(values, str):
        source = [values]
    else:
        source = values
    normalized: set[str] = set()
    for value in source:
        if not isinstance(value, str):
            raise ValueError("terminal statuses must be strings")
        candidate = value.strip().lower()
        if candidate:
            normalized.add(candidate)
    if not normalized:
        raise ValueError("terminal statuses must include at least one non-empty status")
    return normalized


def _require_dispatch_mode(registry: _SkillRegistry, mode: str) -> None:
    if mode not in {_DISPATCH_MODE_SIGNAL, _DISPATCH_MODE_POLLING}:
        raise ValueError(f"unsupported dispatch mode {mode!r}")
    current = registry.dispatch_mode
    if current is None:
        registry.dispatch_mode = mode
        return
    if current != mode:
        raise RuntimeError(
            "remote skill dispatch mode conflict: "
            f"session locked to '{current}', attempted '{mode}'. "
            "Call reset_dispatch_mode() before switching dispatch strategies."
        )


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

    if status is None:
        return _ToolCallSubmission(
            accepted=False,
            retryable=True,
            status="malformed",
            code=code,
            error="tool call response rejected by codex-manager with malformed status payload",
        )

    if status == "ok":
        return _ToolCallSubmission(accepted=True, retryable=False, status=status, code=code)

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
        output_schema = _resolved_skill_output_schema(skill)
        if output_schema:
            output_schema_text = json.dumps(output_schema, ensure_ascii=True, sort_keys=True)
            lines.append(f"  output_schema: {output_schema_text}")
        output_description = skill.output_description.strip() if isinstance(skill.output_description, str) else ""
        if output_description:
            lines.append(f"  output_description: {output_description}")
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


def _resolved_skill_output_schema(skill: RemoteSkill) -> dict[str, Any] | None:
    if isinstance(skill.output_schema, dict):
        cloned = deepcopy(skill.output_schema)
        return cloned if cloned else None
    return None


def _inject_instruction(instruction: str, request_text: str) -> str:
    if not instruction:
        return request_text
    return f"{instruction}\n\nUser request:\n{request_text}"


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

    def clear(self, *, sync_runtime: bool = False, ignore_sync_errors: bool = True) -> int:
        _require_catalog_mutation_allowed(self._registry)
        if sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return _clear_registry_skills(self._registry)

    def dispatch_mode(self) -> str | None:
        return self._registry.dispatch_mode

    def reset_dispatch_mode(self) -> None:
        self._registry.dispatch_mode = None

    def register(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
        sync_runtime: bool = False,
        ignore_sync_errors: bool = True,
    ) -> RemoteSkill:
        _require_catalog_mutation_allowed(self._registry)
        normalized_name = _normalize_skill_name(name)
        skill = RemoteSkill(
            name=normalized_name,
            description=_resolved_skill_description(
                normalized_name=normalized_name, handler=handler, description=description
            ),
            handler=handler,
            input_schema=_schema_enriched_with_docstrings(handler, input_schema),
            output_schema=_resolved_output_schema(handler, output_schema),
            output_description=_resolved_output_description(handler, output_schema),
        )
        self._registry.skills[normalized_name] = skill
        if sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return skill

    def unregister(
        self,
        name: str,
        *,
        sync_runtime: bool = False,
        ignore_sync_errors: bool = True,
    ) -> bool:
        _require_catalog_mutation_allowed(self._registry)
        normalized_name = _normalize_skill_name(name)
        removed = self._registry.skills.pop(normalized_name, None) is not None
        if removed and sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return removed

    def skill(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> Callable[[RemoteSkillHandler], RemoteSkillHandler]:
        def decorator(handler: RemoteSkillHandler) -> RemoteSkillHandler:
            raw_name = name if name is not None else getattr(handler, "__name__", "remote_skill")
            skill_name = raw_name if isinstance(raw_name, str) else "remote_skill"
            self.register(
                skill_name,
                handler,
                description=description,
                input_schema=input_schema,
                output_schema=output_schema,
            )
            return handler

        return decorator

    @contextmanager
    def using(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
        sync_runtime_on_exit: bool = False,
        ignore_sync_errors: bool = True,
    ) -> Iterator[RemoteSkillSession]:
        if sync_runtime_on_exit:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        self.register(
            name,
            handler,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
        )
        try:
            yield self
        finally:
            self.unregister(
                name,
                sync_runtime=False,
                ignore_sync_errors=ignore_sync_errors,
            )

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    def dynamic_tools(self) -> builtins.list[dict[str, Any]]:
        return _dynamic_tool_definitions(self._registry.skills)

    def sync_runtime(self) -> Any:
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

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
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

    def send_prepared(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        prepare_timeout_seconds: float = 90.0,
        **kwargs: Any,
    ) -> Any:
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

    def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
        if "dynamic_tools" not in kwargs:
            kwargs["dynamic_tools"] = self.dynamic_tools()
        payload = self.inject_request(request_text) if inject_skills else request_text
        return self._client.sessions.send_message(
            session_id=self.session_id,
            text=payload,
            **kwargs,
        )

    def send_and_handle(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        terminal_statuses: Iterable[str] | str | None = None,
        require_assistant_reply: bool = False,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
        **kwargs: Any,
    ) -> RemoteSkillSendResult:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be > 0")

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_POLLING)
        terminal = _normalize_statuses(terminal_statuses)

        accepted = self.send(request_text, inject_skills=inject_skills, **kwargs)
        if not isinstance(accepted, dict):
            raise ValueError("remote skill send_and_handle expected dict response with turnId")
        turn_id = accepted.get("turnId")
        if not isinstance(turn_id, str) or not turn_id.strip():
            raise ValueError("remote skill send_and_handle response missing turnId")

        dispatches: builtins.list[RemoteSkillDispatch] = []
        start = time.monotonic()
        while True:
            drained = self.drain_pending_calls(
                max_submit_attempts=max_submit_attempts,
                retry_delay_seconds=retry_delay_seconds,
            )
            dispatches.extend(drained)

            status = self._client.wait.turn_status(session_id=self.session_id, turn_id=turn_id)
            if isinstance(status, str) and status.strip().lower() in terminal:
                break

            if time.monotonic() - start >= timeout_seconds:
                raise WaitTimeoutError(
                    f"remote skill turn {turn_id} did not reach terminal status "
                    f"within {timeout_seconds:.2f}s"
                )
            time.sleep(interval_seconds)

        detail = self._client.sessions.get(session_id=self.session_id)
        final_status = self._client.wait.turn_status(session_id=self.session_id, turn_id=turn_id)
        assistant_reply = _assistant_reply_for_turn(detail, turn_id)
        if require_assistant_reply and assistant_reply is None:
            raise WaitTimeoutError(
                f"turn {turn_id} reached terminal status without an assistant reply"
            )
        return RemoteSkillSendResult(
            session_id=self.session_id,
            turn_id=turn_id,
            accepted=accepted,
            detail=detail,
            status=final_status,
            assistant_reply=assistant_reply,
            dispatches=dispatches,
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
        if not self.matches_signal(signal):
            return None
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_SIGNAL)
        dispatched = self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )
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

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_POLLING)
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

    def clear(self, *, sync_runtime: bool = False, ignore_sync_errors: bool = True) -> int:
        _require_catalog_mutation_allowed(self._registry)
        if sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return _clear_registry_skills(self._registry)

    def dispatch_mode(self) -> str | None:
        return self._registry.dispatch_mode

    def reset_dispatch_mode(self) -> None:
        self._registry.dispatch_mode = None

    def register(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
        sync_runtime: bool = False,
        ignore_sync_errors: bool = True,
    ) -> RemoteSkill:
        _require_catalog_mutation_allowed(self._registry)
        normalized_name = _normalize_skill_name(name)
        skill = RemoteSkill(
            name=normalized_name,
            description=_resolved_skill_description(
                normalized_name=normalized_name, handler=handler, description=description
            ),
            handler=handler,
            input_schema=_schema_enriched_with_docstrings(handler, input_schema),
            output_schema=_resolved_output_schema(handler, output_schema),
            output_description=_resolved_output_description(handler, output_schema),
        )
        self._registry.skills[normalized_name] = skill
        if sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return skill

    def unregister(
        self,
        name: str,
        *,
        sync_runtime: bool = False,
        ignore_sync_errors: bool = True,
    ) -> bool:
        _require_catalog_mutation_allowed(self._registry)
        normalized_name = _normalize_skill_name(name)
        removed = self._registry.skills.pop(normalized_name, None) is not None
        if removed and sync_runtime:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        return removed

    def skill(
        self,
        *,
        name: str | None = None,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> Callable[[RemoteSkillHandler], RemoteSkillHandler]:
        def decorator(handler: RemoteSkillHandler) -> RemoteSkillHandler:
            raw_name = name if name is not None else getattr(handler, "__name__", "remote_skill")
            skill_name = raw_name if isinstance(raw_name, str) else "remote_skill"
            self.register(
                skill_name,
                handler,
                description=description,
                input_schema=input_schema,
                output_schema=output_schema,
            )
            return handler

        return decorator

    @asynccontextmanager
    async def using(
        self,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
        sync_runtime_on_exit: bool = False,
        ignore_sync_errors: bool = True,
    ) -> AsyncIterator[AsyncRemoteSkillSession]:
        if sync_runtime_on_exit:
            raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)
        self.register(
            name,
            handler,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
        )
        try:
            yield self
        finally:
            self.unregister(name, sync_runtime=False)

    def instruction_text(self) -> str:
        return _render_instruction(self._registry.skills)

    def inject_request(self, request_text: str) -> str:
        return _inject_instruction(self.instruction_text(), request_text)

    def dynamic_tools(self) -> builtins.list[dict[str, Any]]:
        return _dynamic_tool_definitions(self._registry.skills)

    async def sync_runtime(self) -> Any:
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

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
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

    async def send_prepared(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        prepare_timeout_seconds: float = 90.0,
        **kwargs: Any,
    ) -> Any:
        raise RuntimeError(_RUNTIME_SYNC_DISABLED_ERROR)

    async def send(self, request_text: str, *, inject_skills: bool = True, **kwargs: Any) -> Any:
        if "dynamic_tools" not in kwargs:
            kwargs["dynamic_tools"] = self.dynamic_tools()
        payload = self.inject_request(request_text) if inject_skills else request_text
        return await self._client.sessions.send_message(
            session_id=self.session_id,
            text=payload,
            **kwargs,
        )

    async def send_and_handle(
        self,
        request_text: str,
        *,
        inject_skills: bool = True,
        timeout_seconds: float = 60.0,
        interval_seconds: float = 0.25,
        terminal_statuses: Iterable[str] | str | None = None,
        require_assistant_reply: bool = False,
        max_submit_attempts: int = _DEFAULT_RESPONSE_SUBMIT_ATTEMPTS,
        retry_delay_seconds: float = _DEFAULT_RESPONSE_RETRY_DELAY_SECONDS,
        **kwargs: Any,
    ) -> RemoteSkillSendResult:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be > 0")
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be > 0")

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_POLLING)
        terminal = _normalize_statuses(terminal_statuses)

        accepted = await self.send(request_text, inject_skills=inject_skills, **kwargs)
        if not isinstance(accepted, dict):
            raise ValueError("remote skill send_and_handle expected dict response with turnId")
        turn_id = accepted.get("turnId")
        if not isinstance(turn_id, str) or not turn_id.strip():
            raise ValueError("remote skill send_and_handle response missing turnId")

        dispatches: builtins.list[RemoteSkillDispatch] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while True:
            drained = await self.drain_pending_calls(
                max_submit_attempts=max_submit_attempts,
                retry_delay_seconds=retry_delay_seconds,
            )
            dispatches.extend(drained)

            status = await self._client.wait.turn_status(
                session_id=self.session_id,
                turn_id=turn_id,
            )
            if isinstance(status, str) and status.strip().lower() in terminal:
                break

            if loop.time() >= deadline:
                raise WaitTimeoutError(
                    f"remote skill turn {turn_id} did not reach terminal status "
                    f"within {timeout_seconds:.2f}s"
                )
            await asyncio.sleep(interval_seconds)

        detail = await self._client.sessions.get(session_id=self.session_id)
        final_status = await self._client.wait.turn_status(
            session_id=self.session_id,
            turn_id=turn_id,
        )
        assistant_reply = _assistant_reply_for_turn(detail, turn_id)
        if require_assistant_reply and assistant_reply is None:
            raise WaitTimeoutError(
                f"turn {turn_id} reached terminal status without an assistant reply"
            )
        return RemoteSkillSendResult(
            session_id=self.session_id,
            turn_id=turn_id,
            accepted=accepted,
            detail=detail,
            status=final_status,
            assistant_reply=assistant_reply,
            dispatches=dispatches,
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
        if not self.matches_signal(signal):
            return None
        tool, arguments, call_id = _parse_tool_call_signal(signal)
        if tool is None:
            return None

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_SIGNAL)
        dispatched = await self.dispatch_tool_call(
            tool=tool,
            arguments=arguments,
            request_id=signal.request_id,
            call_id=call_id,
        )
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

        _require_dispatch_mode(self._registry, _DISPATCH_MODE_POLLING)
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
        registry.catalog_locked = True
        return RemoteSkillSession(client=self._client, session_id=session_id, registry=registry)

    def create_session(
        self,
        *,
        register: Callable[[RemoteSkillSession], None] | None = None,
        **create_kwargs: Any,
    ) -> tuple[Any, RemoteSkillSession]:
        registry = _SkillRegistry(catalog_locked=False)
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
        bound._registry.catalog_locked = True
        return created, bound

    def close_session(
        self,
        session_id: str,
        *,
        delete_session: bool = False,
        sync_runtime_on_cleanup: bool = True,
        ignore_cleanup_errors: bool = True,
    ) -> dict[str, Any]:
        registry = self._registries.setdefault(session_id, _SkillRegistry(catalog_locked=True))
        cleared = _clear_registry_skills(registry)

        delete_response: Any | None = None
        if delete_session:
            try:
                delete_response = self._client.sessions.delete(session_id=session_id)
            except Exception:
                if not ignore_cleanup_errors:
                    raise

        self._registries.pop(session_id, None)
        return {
            "sessionId": session_id,
            "cleared": cleared,
            "deleted": _delete_response_indicates_deleted(delete_response),
            **({"deleteResponse": delete_response} if delete_response is not None else {}),
        }

    @contextmanager
    def lifecycle(
        self,
        *,
        register: Callable[[RemoteSkillSession], None] | None = None,
        keep_session: bool = False,
        sync_runtime_on_cleanup: bool = True,
        ignore_cleanup_errors: bool = True,
        **create_kwargs: Any,
    ) -> Iterator[RemoteSkillLifecycle]:
        created, skills = self.create_session(register=register, **create_kwargs)
        lifecycle = RemoteSkillLifecycle(
            session_id=skills.session_id,
            created=created,
            skills=skills,
        )
        try:
            yield lifecycle
        finally:
            self.close_session(
                skills.session_id,
                delete_session=not keep_session,
                sync_runtime_on_cleanup=sync_runtime_on_cleanup,
                ignore_cleanup_errors=ignore_cleanup_errors,
            )

    def using(
        self,
        session_id: str,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> NoReturn:
        raise RuntimeError(_CATALOG_MUTATION_ERROR)


class AsyncRemoteSkillsFacade:
    """Async remote-skill entrypoint mounted on `AsyncCodexManager.remote_skills`."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._registries: dict[str, _SkillRegistry] = {}

    def session(self, session_id: str) -> AsyncRemoteSkillSession:
        registry = self._registries.setdefault(session_id, _SkillRegistry())
        registry.catalog_locked = True
        return AsyncRemoteSkillSession(
            client=self._client, session_id=session_id, registry=registry
        )

    async def create_session(
        self,
        *,
        register: Callable[[AsyncRemoteSkillSession], None | Awaitable[None]] | None = None,
        **create_kwargs: Any,
    ) -> tuple[Any, AsyncRemoteSkillSession]:
        registry = _SkillRegistry(catalog_locked=False)
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
        bound._registry.catalog_locked = True
        return created, bound

    async def close_session(
        self,
        session_id: str,
        *,
        delete_session: bool = False,
        sync_runtime_on_cleanup: bool = True,
        ignore_cleanup_errors: bool = True,
    ) -> dict[str, Any]:
        registry = self._registries.setdefault(session_id, _SkillRegistry(catalog_locked=True))
        cleared = _clear_registry_skills(registry)

        delete_response: Any | None = None
        if delete_session:
            try:
                delete_response = await self._client.sessions.delete(session_id=session_id)
            except Exception:
                if not ignore_cleanup_errors:
                    raise

        self._registries.pop(session_id, None)
        return {
            "sessionId": session_id,
            "cleared": cleared,
            "deleted": _delete_response_indicates_deleted(delete_response),
            **({"deleteResponse": delete_response} if delete_response is not None else {}),
        }

    @asynccontextmanager
    async def lifecycle(
        self,
        *,
        register: Callable[[AsyncRemoteSkillSession], None | Awaitable[None]] | None = None,
        keep_session: bool = False,
        sync_runtime_on_cleanup: bool = True,
        ignore_cleanup_errors: bool = True,
        **create_kwargs: Any,
    ) -> AsyncIterator[AsyncRemoteSkillLifecycle]:
        created, skills = await self.create_session(register=register, **create_kwargs)
        lifecycle = AsyncRemoteSkillLifecycle(
            session_id=skills.session_id,
            created=created,
            skills=skills,
        )
        try:
            yield lifecycle
        finally:
            await self.close_session(
                skills.session_id,
                delete_session=not keep_session,
                sync_runtime_on_cleanup=sync_runtime_on_cleanup,
                ignore_cleanup_errors=ignore_cleanup_errors,
            )

    async def using(
        self,
        session_id: str,
        name: str,
        handler: RemoteSkillHandler,
        *,
        description: str | None = None,
        input_schema: dict[str, Any] | None = None,
        output_schema: dict[str, Any] | None = None,
    ) -> NoReturn:
        raise RuntimeError(_CATALOG_MUTATION_ERROR)
