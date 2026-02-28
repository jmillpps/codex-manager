"""Typed facade wrappers for sync/async codex-manager clients."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Literal

from pydantic import BaseModel, TypeAdapter, ValidationError

from ..api import SessionSettingsScopeName
from ..errors import TypedModelValidationError
from .contracts import TYPED_OPERATION_CONTRACTS, TypedOperationContract

TypedValidationMode = Literal["typed-only", "off", "strict"]

_VALIDATION_MODES: set[str] = {"typed-only", "off", "strict"}
_adapter_cache: dict[Any, TypeAdapter[Any]] = {}
_MAX_SAMPLE_DEPTH = 2
_MAX_SAMPLE_ITEMS = 5
_MAX_SAMPLE_STRING = 200


def _model_name(model_type: Any) -> str:
    return getattr(model_type, "__name__", repr(model_type))


def _adapter_for(model_type: Any) -> TypeAdapter[Any]:
    try:
        adapter = _adapter_cache.get(model_type)
    except TypeError:
        return TypeAdapter(model_type)

    if adapter is None:
        adapter = TypeAdapter(model_type)
        _adapter_cache[model_type] = adapter
    return adapter


def _sample_payload(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_SAMPLE_DEPTH:
        return "<trimmed>"

    if isinstance(value, dict):
        sampled: dict[str, Any] = {}
        for index, (key, nested) in enumerate(value.items()):
            if index >= _MAX_SAMPLE_ITEMS:
                sampled["..."] = "<trimmed>"
                break
            sampled[str(key)] = _sample_payload(nested, depth + 1)
        return sampled

    if isinstance(value, list):
        sampled_items = [_sample_payload(item, depth + 1) for item in value[:_MAX_SAMPLE_ITEMS]]
        if len(value) > _MAX_SAMPLE_ITEMS:
            sampled_items.append("<trimmed>")
        return sampled_items

    if isinstance(value, str):
        return value if len(value) <= _MAX_SAMPLE_STRING else f"{value[:_MAX_SAMPLE_STRING]}..."

    if isinstance(value, (int, float, bool)) or value is None:
        return value

    return repr(value)


def _resolve_mode(mode_getter: Callable[[], str]) -> TypedValidationMode:
    mode = mode_getter()
    if mode in _VALIDATION_MODES:
        return mode  # type: ignore[return-value]
    return "typed-only"


def _should_validate(mode: TypedValidationMode, override: bool | None) -> bool:
    if override is not None:
        return override
    return mode != "off"


def _normalize_request_field_names(model_type: type[BaseModel], values: Mapping[str, Any]) -> dict[str, Any]:
    alias_to_field_name: dict[str, str] = {}
    for field_name, field in model_type.model_fields.items():
        alias_to_field_name[field_name] = field_name
        if field.alias:
            alias_to_field_name[field.alias] = field_name

    normalized: dict[str, Any] = {}
    for key, value in values.items():
        key_name = key if isinstance(key, str) else str(key)
        normalized_key = alias_to_field_name.get(key_name, key_name)
        normalized[normalized_key] = value
    return normalized


def _serialize_payload_without_validation(
    contract: TypedOperationContract,
    payload: BaseModel | Mapping[str, Any] | None,
    kwargs: Mapping[str, Any],
) -> dict[str, Any]:
    model_type = contract.request_model
    if model_type is None:
        if payload is not None or kwargs:
            raise ValueError(f"{contract.operation_key} does not accept a request payload")
        return {}

    if payload is not None and kwargs:
        raise ValueError(f"{contract.operation_key} accepts either `payload` or keyword fields, not both")

    if payload is None:
        return _normalize_request_field_names(model_type, kwargs)
    if isinstance(payload, BaseModel):
        return payload.model_dump(by_alias=False, exclude_none=True)
    if isinstance(payload, Mapping):
        return _normalize_request_field_names(model_type, payload)

    raise ValueError(
        f"{contract.operation_key} payload must be a pydantic model instance or mapping when validation is disabled"
    )


def _serialize_request_payload(
    contract: TypedOperationContract,
    payload: BaseModel | Mapping[str, Any] | None,
    kwargs: Mapping[str, Any],
    *,
    validate: bool,
) -> dict[str, Any]:
    if not validate:
        return _serialize_payload_without_validation(contract, payload, kwargs)

    model_type = contract.request_model
    if model_type is None:
        if payload is not None or kwargs:
            raise ValueError(f"{contract.operation_key} does not accept a request payload")
        return {}

    if payload is not None and kwargs:
        raise ValueError(f"{contract.operation_key} accepts either `payload` or keyword fields, not both")

    raw_input: Any = dict(kwargs) if payload is None else payload
    if isinstance(raw_input, model_type):
        parsed = raw_input
    else:
        try:
            parsed = model_type.model_validate(raw_input)
        except ValidationError as error:
            raise TypedModelValidationError(
                operation=contract.operation_key,
                boundary="request",
                model_name=_model_name(model_type),
                errors=error.errors(),
                raw_sample=_sample_payload(raw_input),
            ) from error

    return parsed.model_dump(by_alias=False, exclude_none=True)


def _parse_typed_response(
    contract: TypedOperationContract,
    payload: Any,
    *,
    boundary: Literal["request", "response"] = "response",
    status_code: int | None = None,
) -> Any:
    failures: list[dict[str, Any]] = []
    for model_type in contract.response_models:
        adapter = _adapter_for(model_type)
        try:
            return adapter.validate_python(payload)
        except ValidationError as error:
            failures.append(
                {
                    "model": _model_name(model_type),
                    "issues": error.errors(),
                }
            )

    expected = " | ".join(_model_name(model_type) for model_type in contract.response_models)
    raise TypedModelValidationError(
        operation=contract.operation_key,
        boundary=boundary,
        model_name=expected,
        status_code=status_code,
        errors=failures,
        raw_sample=_sample_payload(payload),
    )


def parse_response_for_operation(
    operation_key: str,
    payload: Any,
    *,
    boundary: Literal["request", "response"] = "response",
    status_code: int | None = None,
) -> Any:
    contract = TYPED_OPERATION_CONTRACTS.get(operation_key)
    if contract is None:
        raise ValueError(f"no typed contract registered for operation {operation_key}")
    return _parse_typed_response(contract, payload, boundary=boundary, status_code=status_code)


class TypedSessionsApi:
    def __init__(self, sessions_api: Any, mode_getter: Callable[[], str]) -> None:
        self._sessions = sessions_api
        self._mode_getter = mode_getter

    def create(self, payload: BaseModel | Mapping[str, Any] | None = None, *, validate: bool | None = None, **kwargs: Any) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.create"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.create(**body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def get(self, *, session_id: str, validate: bool | None = None) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.get"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = self._sessions.get(session_id=session_id)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def send_message(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.send_message"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.send_message(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def settings_get(
        self,
        *,
        session_id: str,
        scope: SessionSettingsScopeName = "session",
        key: str | None = None,
        validate: bool | None = None,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.get"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = self._sessions.settings_get(session_id=session_id, scope=scope, key=key)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def settings_set(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.set"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.settings_set(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def settings_unset(
        self,
        *,
        session_id: str,
        key: str,
        scope: SessionSettingsScopeName = "session",
        actor: str | None = None,
        source: str | None = None,
        validate: bool | None = None,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.unset"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = self._sessions.settings_unset(
            session_id=session_id,
            key=key,
            scope=scope,
            actor=actor,
            source=source,
        )
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def suggest_request(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.suggest_request(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def suggest_request_enqueue(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request.enqueue"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.suggest_request_enqueue(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    def suggest_request_upsert(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request.upsert"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._sessions.suggest_request_upsert(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class TypedApprovalsApi:
    def __init__(self, approvals_api: Any, mode_getter: Callable[[], str]) -> None:
        self._approvals = approvals_api
        self._mode_getter = mode_getter

    def decide(
        self,
        *,
        approval_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["approvals.decide"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._approvals.decide(approval_id=approval_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class TypedToolInputApi:
    def __init__(self, tool_input_api: Any, mode_getter: Callable[[], str]) -> None:
        self._tool_input = tool_input_api
        self._mode_getter = mode_getter

    def decide(
        self,
        *,
        request_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["tool_input.decide"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = self._tool_input.decide(request_id=request_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class AsyncTypedSessionsApi:
    def __init__(self, sessions_api: Any, mode_getter: Callable[[], str]) -> None:
        self._sessions = sessions_api
        self._mode_getter = mode_getter

    async def create(
        self,
        payload: BaseModel | Mapping[str, Any] | None = None,
        *,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.create"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.create(**body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def get(self, *, session_id: str, validate: bool | None = None) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.get"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = await self._sessions.get(session_id=session_id)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def send_message(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.send_message"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.send_message(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def settings_get(
        self,
        *,
        session_id: str,
        scope: SessionSettingsScopeName = "session",
        key: str | None = None,
        validate: bool | None = None,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.get"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = await self._sessions.settings_get(session_id=session_id, scope=scope, key=key)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def settings_set(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.set"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.settings_set(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def settings_unset(
        self,
        *,
        session_id: str,
        key: str,
        scope: SessionSettingsScopeName = "session",
        actor: str | None = None,
        source: str | None = None,
        validate: bool | None = None,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.settings.unset"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        response = await self._sessions.settings_unset(
            session_id=session_id,
            key=key,
            scope=scope,
            actor=actor,
            source=source,
        )
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def suggest_request(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.suggest_request(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def suggest_request_enqueue(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request.enqueue"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.suggest_request_enqueue(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)

    async def suggest_request_upsert(
        self,
        *,
        session_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["sessions.suggest_request.upsert"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._sessions.suggest_request_upsert(session_id=session_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class AsyncTypedApprovalsApi:
    def __init__(self, approvals_api: Any, mode_getter: Callable[[], str]) -> None:
        self._approvals = approvals_api
        self._mode_getter = mode_getter

    async def decide(
        self,
        *,
        approval_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["approvals.decide"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._approvals.decide(approval_id=approval_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class AsyncTypedToolInputApi:
    def __init__(self, tool_input_api: Any, mode_getter: Callable[[], str]) -> None:
        self._tool_input = tool_input_api
        self._mode_getter = mode_getter

    async def decide(
        self,
        *,
        request_id: str,
        payload: BaseModel | Mapping[str, Any] | None = None,
        validate: bool | None = None,
        **kwargs: Any,
    ) -> Any:
        contract = TYPED_OPERATION_CONTRACTS["tool_input.decide"]
        should_validate = _should_validate(_resolve_mode(self._mode_getter), validate)
        body = _serialize_request_payload(contract, payload, kwargs, validate=should_validate)
        response = await self._tool_input.decide(request_id=request_id, **body)
        if not should_validate:
            return response
        return _parse_typed_response(contract, response)


class TypedCodexManagerFacade:
    def __init__(self, client: Any) -> None:
        mode_getter = lambda: getattr(client, "_validation_mode", "typed-only")
        self.sessions = TypedSessionsApi(client.sessions, mode_getter)
        self.approvals = TypedApprovalsApi(client.approvals, mode_getter)
        self.tool_input = TypedToolInputApi(client.tool_input, mode_getter)

    def parse(self, operation_key: str, payload: Any, *, status_code: int | None = None) -> Any:
        return parse_response_for_operation(operation_key, payload, status_code=status_code)


class AsyncTypedCodexManagerFacade:
    def __init__(self, client: Any) -> None:
        mode_getter = lambda: getattr(client, "_validation_mode", "typed-only")
        self.sessions = AsyncTypedSessionsApi(client.sessions, mode_getter)
        self.approvals = AsyncTypedApprovalsApi(client.approvals, mode_getter)
        self.tool_input = AsyncTypedToolInputApi(client.tool_input, mode_getter)

    def parse(self, operation_key: str, payload: Any, *, status_code: int | None = None) -> Any:
        return parse_response_for_operation(operation_key, payload, status_code=status_code)


__all__ = [
    "AsyncTypedApprovalsApi",
    "AsyncTypedCodexManagerFacade",
    "AsyncTypedSessionsApi",
    "AsyncTypedToolInputApi",
    "TypedApprovalsApi",
    "TypedCodexManagerFacade",
    "TypedSessionsApi",
    "TypedToolInputApi",
    "TypedValidationMode",
    "parse_response_for_operation",
]
