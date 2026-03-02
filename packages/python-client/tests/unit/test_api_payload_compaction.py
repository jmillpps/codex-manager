from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from codex_manager import CodexManager


@dataclass
class _Executor:
    calls: list[dict[str, Any]] = field(default_factory=list)

    def request(self, **kwargs: Any) -> Any:
        self.calls.append(dict(kwargs))
        return {"status": "ok"}


def test_sessions_send_message_omits_optional_none_fields() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.sessions.send_message(session_id="session-1", text="hello")
    finally:
        client.close()

    call = executor.calls[0]
    assert call["operation"] == "sessions.send_message"
    assert call["json_body"] == {"text": "hello"}


def test_tool_calls_respond_omits_optional_none_fields() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.tool_calls.respond(request_id="req-1", response={"success": True})
    finally:
        client.close()

    call = executor.calls[0]
    assert call["operation"] == "tool_calls.respond"
    assert call["json_body"] == {"response": {"success": True}}


def test_approvals_decide_omits_scope_none_and_allows_structured_errors() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.approvals.decide(approval_id="approval-1", decision="accept")
    finally:
        client.close()

    call = executor.calls[0]
    assert call["operation"] == "approvals.decide"
    assert call["json_body"] == {"decision": "accept"}
    assert call["allow_statuses"] == (200, 404, 409, 500)


def test_tool_input_decide_omits_answers_and_response_none() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.tool_input.decide(request_id="input-1", decision="cancel")
    finally:
        client.close()

    call = executor.calls[0]
    assert call["operation"] == "tool_input.decide"
    assert call["json_body"] == {"decision": "cancel"}
    assert call["allow_statuses"] == (200, 404, 500)


def test_settings_set_keeps_explicit_null_value_for_key_mode() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.sessions.settings_set(session_id="session-1", key="feature.flag", value=None)
    finally:
        client.close()

    call = executor.calls[0]
    assert call["operation"] == "sessions.settings.set"
    assert call["json_body"]["key"] == "feature.flag"
    assert "value" in call["json_body"]
    assert call["json_body"]["value"] is None


def test_session_management_surfaces_allow_system_owned_status() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.sessions.approvals(session_id="session-1")
        client.sessions.tool_input(session_id="session-1")
        client.sessions.controls_get(session_id="session-1")
        client.sessions.controls_apply(
            session_id="session-1",
            controls={
                "model": None,
                "approvalPolicy": "on-request",
                "networkAccess": "restricted",
                "filesystemSandbox": "workspace-write",
            },
        )
        client.sessions.settings_get(session_id="session-1")
        client.sessions.settings_set(session_id="session-1", key="feature.flag", value=True)
        client.sessions.settings_unset(session_id="session-1", key="feature.flag")
        client.sessions.resume(session_id="session-1")
    finally:
        client.close()

    by_operation = {call["operation"]: call for call in executor.calls}
    assert by_operation["sessions.approvals.list"]["allow_statuses"] == (200, 403, 410)
    assert by_operation["sessions.tool_input.list"]["allow_statuses"] == (200, 403, 410)
    assert by_operation["sessions.controls.get"]["allow_statuses"] == (200, 403, 404, 410)
    assert by_operation["sessions.controls.apply"]["allow_statuses"] == (200, 400, 403, 404, 410, 423)
    assert by_operation["sessions.settings.get"]["allow_statuses"] == (200, 403, 404, 410)
    assert by_operation["sessions.settings.set"]["allow_statuses"] == (200, 400, 403, 404, 410, 423)
    assert by_operation["sessions.settings.unset"]["allow_statuses"] == (200, 403, 404, 410, 423)
    assert by_operation["sessions.resume"]["allow_statuses"] == (200, 403, 410)


def test_turn_and_suggestion_wrappers_allow_expected_non_2xx_statuses() -> None:
    executor = _Executor()
    client = CodexManager(request_executor=executor)
    try:
        client.sessions.send_message(session_id="session-1", text="hello")
        client.sessions.interrupt(session_id="session-1")
        client.sessions.approval_policy(session_id="session-1", approval_policy="on-request")
        client.sessions.suggest_request(session_id="session-1")
        client.sessions.suggest_request_enqueue(session_id="session-1")
        client.sessions.suggest_request_upsert(
            session_id="session-1",
            request_key="request-1",
            status="streaming",
        )
    finally:
        client.close()

    by_operation = {call["operation"]: call for call in executor.calls}
    assert by_operation["sessions.send_message"]["allow_statuses"] == (202, 400, 403, 404, 410)
    assert by_operation["sessions.interrupt"]["allow_statuses"] == (200, 403, 404, 409, 410)
    assert by_operation["sessions.approval_policy.set"]["allow_statuses"] == (200, 403, 404, 410)
    assert by_operation["sessions.suggest_request"]["allow_statuses"] == (200, 202, 400, 403, 404, 409, 410, 429, 503)
    assert by_operation["sessions.suggest_request.enqueue"]["allow_statuses"] == (202, 400, 403, 404, 409, 410, 429, 503)
    assert by_operation["sessions.suggest_request.upsert"]["allow_statuses"] == (200, 400, 403, 404, 410)
