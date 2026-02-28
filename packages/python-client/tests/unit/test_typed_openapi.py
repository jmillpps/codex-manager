from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from codex_manager import AsyncCodexManager, CodexManager
from codex_manager.errors import TypedModelValidationError
from codex_manager.typed import (
    ALL_OPENAPI_OPERATION_IDS,
    RAW_OPERATION_IDS,
    TYPED_OPERATION_IDS,
    ApprovalDecisionNotFoundResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    SuggestedRequestQueuedResponse,
)


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


def test_typed_sessions_create_parses_generated_model() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor)
    try:
        response = client.typed.sessions.create(cwd="/workspace", model="gpt-5")
    finally:
        client.close()

    assert isinstance(response, CreateSessionResponse)
    assert response.session.session_id == "sess-1"
    assert response.session.session_controls.approval_policy == "on-request"
    assert executor.calls[0]["json_body"]["cwd"] == "/workspace"
    assert executor.calls[0]["json_body"]["model"] == "gpt-5"


def test_typed_sessions_create_accepts_alias_fields_via_model_payload() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor)
    try:
        response = client.typed.sessions.create(
            payload=CreateSessionRequest(
                cwd="/workspace",
                approval_policy="on-request",
                network_access="enabled",
                filesystem_sandbox="workspace-write",
            )
        )
    finally:
        client.close()

    assert isinstance(response, CreateSessionResponse)
    assert executor.calls[0]["json_body"]["approvalPolicy"] == "on-request"
    assert executor.calls[0]["json_body"]["networkAccess"] == "enabled"
    assert executor.calls[0]["json_body"]["filesystemSandbox"] == "workspace-write"


def test_typed_sessions_create_mode_off_still_supports_model_payload_alias_fields() -> None:
    executor = _SyncExecutor(responses={"sessions.create": _create_session_payload()})
    client = CodexManager(request_executor=executor, validation_mode="off")
    try:
        response = client.typed.sessions.create(
            payload=CreateSessionRequest(
                cwd="/workspace",
                approval_policy="on-request",
            )
        )
    finally:
        client.close()

    assert isinstance(response, dict)
    assert response["session"]["sessionId"] == "sess-1"
    assert executor.calls[0]["json_body"]["approvalPolicy"] == "on-request"


def test_typed_validation_error_includes_operation_and_model() -> None:
    executor = _SyncExecutor(responses={"sessions.create": {"status": "ok"}})
    client = CodexManager(request_executor=executor)
    try:
        with pytest.raises(TypedModelValidationError) as error_info:
            client.typed.sessions.create(cwd="/workspace")
    finally:
        client.close()

    assert error_info.value.operation == "sessions.create"
    assert "CreateSessionResponse" in error_info.value.model_name
    assert error_info.value.boundary == "response"
    assert error_info.value.raw_sample == {"status": "ok"}
    assert isinstance(error_info.value.errors, list)


def test_typed_union_response_parses_suggested_request_queue_result() -> None:
    executor = _SyncExecutor(
        responses={
            "sessions.suggest_request": {
                "status": "queued",
                "jobId": "job-1",
                "requestKey": "req-1",
                "sessionId": "sess-1",
                "projectId": "project-1",
                "dedupe": "enqueued",
            }
        }
    )
    client = CodexManager(request_executor=executor)
    try:
        response = client.typed.sessions.suggest_request(session_id="sess-1")
    finally:
        client.close()

    assert isinstance(response, SuggestedRequestQueuedResponse)
    assert response.job_id == "job-1"
    assert response.request_key == "req-1"


@pytest.mark.asyncio
async def test_async_typed_parse_for_approval_decision() -> None:
    executor = _AsyncExecutor(
        responses={
            "approvals.decide": {
                "status": "not_found",
                "approvalId": "appr-1",
            }
        }
    )
    client = AsyncCodexManager(request_executor=executor)
    try:
        response = await client.typed.approvals.decide(approval_id="appr-1", decision="accept")
    finally:
        await client.close()

    assert isinstance(response, ApprovalDecisionNotFoundResponse)
    assert response.approval_id == "appr-1"


def test_typed_contract_surface_covers_every_openapi_operation_id() -> None:
    openapi_path = Path(__file__).resolve().parents[4] / "apps" / "api" / "openapi" / "openapi.json"
    document = json.loads(openapi_path.read_text(encoding="utf-8"))

    openapi_ids: set[str] = set()
    for methods in document.get("paths", {}).values():
        for operation in methods.values():
            operation_id = operation.get("operationId")
            if isinstance(operation_id, str) and operation_id:
                openapi_ids.add(operation_id)

    assert openapi_ids == ALL_OPENAPI_OPERATION_IDS
    assert not (RAW_OPERATION_IDS & TYPED_OPERATION_IDS)
    assert RAW_OPERATION_IDS | TYPED_OPERATION_IDS == ALL_OPENAPI_OPERATION_IDS
