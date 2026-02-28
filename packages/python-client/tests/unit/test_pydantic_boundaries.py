from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from codex_manager import AsyncCodexManager, CodexManager
from codex_manager.errors import TypedModelValidationError
from codex_manager.typed import CreateSessionResponse


def _create_session_payload(session_id: str = "sess-1") -> dict[str, Any]:
    return {
        "session": {
            "sessionId": session_id,
            "title": "New chat",
            "materialized": False,
            "modelProvider": "gpt-5",
            "approvalPolicy": "on-request",
            "sessionControls": {
                "model": "gpt-5",
                "approvalPolicy": "on-request",
                "networkAccess": "restricted",
                "filesystemSandbox": "workspace-write",
            },
            "createdAt": 1,
            "updatedAt": 2,
            "cwd": "/workspace",
            "source": "user",
            "projectId": None,
        },
        "thread": {
            "id": session_id,
            "preview": "hello",
            "modelProvider": "gpt-5",
            "createdAt": 1,
            "updatedAt": 2,
            "cwd": "/workspace",
            "source": {"kind": "local"},
            "turns": [],
        },
    }


def _deleted_session_payload(session_id: str = "sess-1") -> dict[str, Any]:
    return {
        "status": "deleted",
        "sessionId": session_id,
        "title": "Deleted",
        "message": "Session removed",
        "deletedAt": "2026-01-01T00:00:00.000Z",
    }


@dataclass
class _SyncExecutor:
    responses: dict[str, Any]
    calls: list[dict[str, Any]] = field(default_factory=list)

    def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        operation = str(kwargs["operation"])
        if operation not in self.responses:
            raise AssertionError(f"missing mocked response for operation {operation}")
        return self.responses[operation]


@dataclass
class _AsyncExecutor:
    responses: dict[str, Any]
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        operation = str(kwargs["operation"])
        if operation not in self.responses:
            raise AssertionError(f"missing mocked response for operation {operation}")
        return self.responses[operation]


def test_typed_validation_default_mode_parses_models() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor)
    try:
        response = client.typed.sessions.create(cwd="/workspace")
    finally:
        client.close()

    assert isinstance(response, CreateSessionResponse)


def test_invalid_validation_mode_rejected() -> None:
    with pytest.raises(ValueError):
        CodexManager(validation_mode="unsupported")  # type: ignore[arg-type]


def test_env_validation_mode_off_returns_raw_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_MANAGER_PY_VALIDATION_MODE", "off")
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(request_executor=executor)
    try:
        response = client.typed.sessions.create(cwd="/workspace")
    finally:
        client.close()

    assert response == {"status": "ok"}


def test_invalid_env_validation_mode_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_MANAGER_PY_VALIDATION_MODE", "not-a-mode")
    with pytest.raises(ValueError):
        CodexManager()


def test_validate_override_true_forces_typed_parsing_when_mode_off() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor, validation_mode="off")
    try:
        response = client.typed.sessions.create(cwd="/workspace", validate=True)
    finally:
        client.close()

    assert isinstance(response, CreateSessionResponse)


def test_validate_override_false_disables_typed_parsing_when_mode_typed_only() -> None:
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(request_executor=executor, validation_mode="typed-only")
    try:
        response = client.typed.sessions.create(cwd="/workspace", validate=False)
    finally:
        client.close()

    assert response == {"status": "ok"}


def test_validate_false_normalizes_alias_kwargs_without_validation() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor, validation_mode="off")
    try:
        response = client.typed.sessions.create(
            cwd="/workspace",
            approvalPolicy="on-request",
            validate=False,
        )
    finally:
        client.close()

    assert response["session"]["sessionId"] == "sess-1"
    assert executor.calls[0]["json_body"]["approvalPolicy"] == "on-request"


def test_validate_false_normalizes_alias_mapping_without_validation() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor, validation_mode="off")
    try:
        response = client.typed.sessions.create(
            payload={"cwd": "/workspace", "approvalPolicy": "on-request"},
            validate=False,
        )
    finally:
        client.close()

    assert response["session"]["sessionId"] == "sess-1"
    assert executor.calls[0]["json_body"]["approvalPolicy"] == "on-request"


def test_request_boundary_validation_error_contains_context() -> None:
    executor = _SyncExecutor(responses={"sessions.send_message": {"status": "accepted"}})
    client = CodexManager(request_executor=executor)
    try:
        with pytest.raises(TypedModelValidationError) as error_info:
            client.typed.sessions.send_message(
                session_id="sess-1",
                payload={"model": "gpt-5"},
            )
    finally:
        client.close()

    error = error_info.value
    assert error.operation == "sessions.send_message"
    assert error.boundary == "request"
    assert error.status_code is None
    assert error.raw_sample == {"model": "gpt-5"}
    assert executor.calls == []


def test_response_boundary_validation_error_contains_context() -> None:
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(request_executor=executor)
    try:
        with pytest.raises(TypedModelValidationError) as error_info:
            client.typed.sessions.create(cwd="/workspace")
    finally:
        client.close()

    error = error_info.value
    assert error.operation == "sessions.create"
    assert error.boundary == "response"
    assert error.status_code is None
    assert error.raw_sample == {"status": "ok"}


def test_strict_mode_validates_dict_domain_responses() -> None:
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(request_executor=executor, validation_mode="strict")
    try:
        with pytest.raises(TypedModelValidationError) as error_info:
            client.sessions.create(cwd="/workspace")
    finally:
        client.close()

    error = error_info.value
    assert error.operation == "sessions.create"
    assert error.boundary == "response"


def test_strict_mode_ignores_non_strict_operations() -> None:
    executor = _SyncExecutor(responses={"system.health": {"status": "ok"}})
    client = CodexManager(request_executor=executor, validation_mode="strict")
    try:
        response = client.system.health()
    finally:
        client.close()

    assert response == {"status": "ok"}


def test_strict_mode_accepts_union_response_shape() -> None:
    payload = _deleted_session_payload()
    executor = _SyncExecutor(responses={"sessions.get": payload})
    client = CodexManager(request_executor=executor, validation_mode="strict")
    try:
        response = client.sessions.get(session_id="sess-1")
    finally:
        client.close()

    assert response is payload
    assert response["status"] == "deleted"


def test_strict_validation_error_does_not_retry() -> None:
    class RetryPolicy:
        def __init__(self) -> None:
            self.should_retry_calls = 0

        def should_retry(
            self, *, attempt: int, error: Exception | None, status_code: int | None
        ) -> bool:
            self.should_retry_calls += 1
            return True

        def next_delay_seconds(self, *, attempt: int) -> float:
            return 0.0

    policy = RetryPolicy()
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(
        request_executor=executor,
        validation_mode="strict",
        retry_policy=policy,
        retryable_operations={"sessions.create"},
    )
    try:
        with pytest.raises(TypedModelValidationError):
            client.sessions.create(cwd="/workspace")
    finally:
        client.close()

    assert len(executor.calls) == 1
    assert policy.should_retry_calls == 0


@pytest.mark.asyncio
async def test_async_strict_mode_validates_dict_domain_responses() -> None:
    executor = _AsyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = AsyncCodexManager(request_executor=executor, validation_mode="strict")
    try:
        with pytest.raises(TypedModelValidationError) as error_info:
            await client.sessions.create(cwd="/workspace")
    finally:
        await client.close()

    assert error_info.value.operation == "sessions.create"
