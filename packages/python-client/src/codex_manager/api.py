"""Domain APIs and session-scoped wrappers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, TypeAlias

RequestFn = Callable[..., Any]
ReasoningEffort: TypeAlias = Literal["none", "minimal", "low", "medium", "high", "xhigh"]
ApprovalPolicy: TypeAlias = Literal["untrusted", "on-failure", "on-request", "never"]
NetworkAccess: TypeAlias = Literal["restricted", "enabled"]
FilesystemSandbox: TypeAlias = Literal["read-only", "workspace-write", "danger-full-access"]
SessionSettingsScopeName: TypeAlias = Literal["session", "default"]
ApprovalDecision: TypeAlias = Literal["accept", "decline", "cancel"]
ToolInputDecision: TypeAlias = Literal["accept", "decline", "cancel"]


def _ensure_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        current = merged.get(key)
        if isinstance(current, dict) and isinstance(value, dict):
            merged[key] = _deep_merge(current, value)
            continue
        merged[key] = value
    return merged


def _namespace_parts(namespace: str) -> list[str]:
    return [part for part in namespace.split(".") if part]


class RawApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def request(
        self,
        method: str,
        path: str,
        *,
        operation: str = "raw.request",
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: tuple[int, ...] | None = None,
    ) -> Any:
        return self._request(
            operation=operation,
            method=method,
            path=path,
            query=query,
            json_body=body,
            headers=headers,
            allow_statuses=allow_statuses,
        )


class SystemApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def health(self) -> Any:
        return self._request("system.health", "GET", "/health")

    def info(self) -> Any:
        return self._request("system.info", "GET", "")

    def capabilities(self, *, refresh: bool = False) -> Any:
        return self._request("system.capabilities", "GET", "/capabilities", query={"refresh": refresh})

    def experimental_features(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        return self._request(
            "system.features.experimental",
            "GET",
            "/features/experimental",
            query={"cursor": cursor, "limit": limit},
            allow_statuses=(200, 501),
        )

    def collaboration_modes(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        return self._request(
            "system.collaboration.modes",
            "GET",
            "/collaboration/modes",
            query={"cursor": cursor, "limit": limit},
            allow_statuses=(200, 501),
        )


class ModelsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        return self._request(
            "models.list",
            "GET",
            "/models",
            query={"cursor": cursor, "limit": limit},
            allow_statuses=(200, 501),
        )


class AppsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(
        self,
        *,
        cursor: str | None = None,
        limit: int | None = None,
        thread_id: str | None = None,
        force_refetch: bool | None = None,
    ) -> Any:
        return self._request(
            "apps.list",
            "GET",
            "/apps",
            query={
                "cursor": cursor,
                "limit": limit,
                "threadId": thread_id,
                "forceRefetch": force_refetch,
            },
            allow_statuses=(200, 501),
        )


class SkillsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(self, *, force_reload: bool | None = None, cwd: str | None = None) -> Any:
        return self._request(
            "skills.list",
            "GET",
            "/skills",
            query={"forceReload": force_reload, "cwd": cwd},
            allow_statuses=(200, 501),
        )

    def set_config(self, *, path: str, enabled: bool) -> Any:
        return self._request(
            "skills.config.set",
            "POST",
            "/skills/config",
            json_body={"path": path, "enabled": enabled},
            allow_statuses=(200, 501),
        )

    def remote_get(self) -> Any:
        return self._request("skills.remote.get", "GET", "/skills/remote", allow_statuses=(200, 500, 501))

    def remote_set(self, *, hazelnut_id: str, is_preload: bool) -> Any:
        return self._request(
            "skills.remote.set",
            "POST",
            "/skills/remote",
            json_body={"hazelnutId": hazelnut_id, "isPreload": is_preload},
            allow_statuses=(200, 501),
        )


class McpApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def reload(self) -> Any:
        return self._request("mcp.reload", "POST", "/mcp/reload", allow_statuses=(200, 501))

    def servers(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        return self._request(
            "mcp.servers.list",
            "GET",
            "/mcp/servers",
            query={"cursor": cursor, "limit": limit},
            allow_statuses=(200, 501),
        )

    def oauth_login(
        self,
        *,
        server_name: str,
        scopes: list[str] | None = None,
        timeout_secs: int | None = None,
    ) -> Any:
        return self._request(
            "mcp.oauth.login",
            "POST",
            f"/mcp/servers/{server_name}/oauth/login",
            json_body={"scopes": scopes, "timeoutSecs": timeout_secs},
            allow_statuses=(200, 501),
        )


class AccountApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def get(self) -> Any:
        return self._request("account.get", "GET", "/account", allow_statuses=(200, 401, 501))

    def login_start(self, payload: dict[str, Any]) -> Any:
        return self._request(
            "account.login.start",
            "POST",
            "/account/login/start",
            json_body=payload,
            allow_statuses=(200, 400, 501),
        )

    def login_start_api_key(self, api_key: str) -> Any:
        return self.login_start({"type": "apiKey", "apiKey": api_key})

    def login_start_chatgpt(self) -> Any:
        return self.login_start({"type": "chatgpt"})

    def login_start_chatgpt_auth_tokens(
        self,
        *,
        access_token: str,
        chatgpt_account_id: str,
        chatgpt_plan_type: str | None = None,
    ) -> Any:
        payload: dict[str, Any] = {
            "type": "chatgptAuthTokens",
            "accessToken": access_token,
            "chatgptAccountId": chatgpt_account_id,
        }
        if chatgpt_plan_type:
            payload["chatgptPlanType"] = chatgpt_plan_type
        return self.login_start(payload)

    def login_cancel(self, *, login_id: str) -> Any:
        return self._request(
            "account.login.cancel",
            "POST",
            "/account/login/cancel",
            json_body={"loginId": login_id},
            allow_statuses=(200, 404, 501),
        )

    def logout(self) -> Any:
        return self._request("account.logout", "POST", "/account/logout", json_body={}, allow_statuses=(200, 501))

    def rate_limits(self) -> Any:
        return self._request("account.rate_limits", "GET", "/account/rate-limits", allow_statuses=(200, 401, 501))


class ConfigApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def get(self, *, cwd: str | None = None, include_layers: bool | None = None) -> Any:
        return self._request(
            "config.get",
            "GET",
            "/config",
            query={"cwd": cwd, "includeLayers": include_layers},
            allow_statuses=(200, 501),
        )

    def requirements(self) -> Any:
        return self._request("config.requirements", "GET", "/config/requirements", allow_statuses=(200, 501))

    def set(
        self,
        *,
        key_path: str,
        merge_strategy: str,
        value: Any,
        expected_version: str | None = None,
        file_path: str | None = None,
    ) -> Any:
        return self._request(
            "config.set",
            "POST",
            "/config/value",
            json_body={
                "keyPath": key_path,
                "mergeStrategy": merge_strategy,
                "value": value,
                "expectedVersion": expected_version,
                "filePath": file_path,
            },
            allow_statuses=(200, 501),
        )

    def batch_set(
        self,
        *,
        edits: list[dict[str, Any]],
        expected_version: str | None = None,
        file_path: str | None = None,
    ) -> Any:
        return self._request(
            "config.batch_set",
            "POST",
            "/config/batch",
            json_body={"edits": edits, "expectedVersion": expected_version, "filePath": file_path},
            allow_statuses=(200, 501),
        )


class RuntimeApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def exec(self, *, command: list[str], cwd: str | None = None, timeout_ms: int | None = None) -> Any:
        return self._request(
            "runtime.exec",
            "POST",
            "/commands/exec",
            json_body={"command": command, "cwd": cwd, "timeoutMs": timeout_ms},
            allow_statuses=(200, 501),
        )


class FeedbackApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def submit(
        self,
        *,
        classification: str,
        include_logs: bool,
        reason: str | None = None,
        thread_id: str | None = None,
    ) -> Any:
        return self._request(
            "feedback.submit",
            "POST",
            "/feedback",
            json_body={
                "classification": classification,
                "includeLogs": include_logs,
                "reason": reason,
                "threadId": thread_id,
            },
            allow_statuses=(200, 501),
        )


class ExtensionsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(self) -> Any:
        return self._request("extensions.list", "GET", "/agents/extensions")

    def reload(self) -> Any:
        return self._request("extensions.reload", "POST", "/agents/extensions/reload")


class OrchestratorApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def get(self, *, job_id: str) -> Any:
        return self._request("orchestrator.jobs.get", "GET", f"/orchestrator/jobs/{job_id}")

    def list(self, *, project_id: str, state: str | None = None) -> Any:
        return self._request(
            "orchestrator.jobs.list",
            "GET",
            f"/projects/{project_id}/orchestrator/jobs",
            query={"state": state},
        )

    def cancel(self, *, job_id: str) -> Any:
        return self._request(
            "orchestrator.jobs.cancel",
            "POST",
            f"/orchestrator/jobs/{job_id}/cancel",
            allow_statuses=(200, 404, 409),
        )


class ProjectsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(self) -> Any:
        return self._request("projects.list", "GET", "/projects")

    def create(self, *, name: str) -> Any:
        return self._request("projects.create", "POST", "/projects", json_body={"name": name})

    def rename(self, *, project_id: str, name: str) -> Any:
        return self._request(
            "projects.rename",
            "POST",
            f"/projects/{project_id}/rename",
            json_body={"name": name},
        )

    def delete(self, *, project_id: str) -> Any:
        return self._request("projects.delete", "DELETE", f"/projects/{project_id}", allow_statuses=(200, 404))

    def list_agent_sessions(self, *, project_id: str) -> Any:
        return self._request(
            "projects.agent_sessions.list",
            "GET",
            f"/projects/{project_id}/agent-sessions",
            allow_statuses=(200, 404),
        )

    def move_all_chats(self, *, project_id: str, destination: str) -> Any:
        return self._request(
            "projects.chats.move_all",
            "POST",
            f"/projects/{project_id}/chats/move-all",
            json_body={"destination": destination},
        )

    def delete_all_chats(self, *, project_id: str) -> Any:
        return self._request(
            "projects.chats.delete_all",
            "POST",
            f"/projects/{project_id}/chats/delete-all",
            json_body={},
        )

    def orchestrator_jobs(self, *, project_id: str, state: str | None = None) -> Any:
        return self._request(
            "projects.orchestrator.jobs.list",
            "GET",
            f"/projects/{project_id}/orchestrator/jobs",
            query={"state": state},
        )


class ApprovalsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def decide(
        self,
        *,
        approval_id: str,
        decision: ApprovalDecision,
        scope: Literal["turn", "session"] | None = None,
    ) -> Any:
        return self._request(
            "approvals.decide",
            "POST",
            f"/approvals/{approval_id}/decision",
            json_body={"decision": decision, "scope": scope},
            allow_statuses=(200, 404),
        )


class ToolInputApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def decide(
        self,
        *,
        request_id: str,
        decision: ToolInputDecision,
        answers: dict[str, dict[str, list[str]]] | None = None,
        response: Any | None = None,
    ) -> Any:
        return self._request(
            "tool_input.decide",
            "POST",
            f"/tool-input/{request_id}/decision",
            json_body={"decision": decision, "answers": answers, "response": response},
            allow_statuses=(200, 404),
        )


class SessionsApi:
    def __init__(self, request: RequestFn) -> None:
        self._request = request

    def list(
        self,
        *,
        archived: bool | None = None,
        cursor: str | None = None,
        limit: int | None = None,
        include_system_owned: bool | None = None,
    ) -> Any:
        return self._request(
            "sessions.list",
            "GET",
            "/sessions",
            query={
                "archived": archived,
                "cursor": cursor,
                "limit": limit,
                "includeSystemOwned": include_system_owned,
            },
        )

    def create(
        self,
        *,
        cwd: str | None = None,
        model: str | None = None,
        approval_policy: ApprovalPolicy | None = None,
        network_access: NetworkAccess | None = None,
        filesystem_sandbox: FilesystemSandbox | None = None,
    ) -> Any:
        return self._request(
            "sessions.create",
            "POST",
            "/sessions",
            json_body={
                "cwd": cwd,
                "model": model,
                "approvalPolicy": approval_policy,
                "networkAccess": network_access,
                "filesystemSandbox": filesystem_sandbox,
            },
        )

    def get(self, *, session_id: str) -> Any:
        return self._request("sessions.get", "GET", f"/sessions/{session_id}", allow_statuses=(200, 410))

    def delete(self, *, session_id: str) -> Any:
        return self._request("sessions.delete", "DELETE", f"/sessions/{session_id}", allow_statuses=(200, 404, 410))

    def fork(self, *, session_id: str) -> Any:
        return self._request("sessions.fork", "POST", f"/sessions/{session_id}/fork", allow_statuses=(200, 410, 501))

    def compact(self, *, session_id: str) -> Any:
        return self._request(
            "sessions.compact",
            "POST",
            f"/sessions/{session_id}/compact",
            allow_statuses=(200, 410, 501),
        )

    def rollback(self, *, session_id: str, num_turns: int = 1) -> Any:
        return self._request(
            "sessions.rollback",
            "POST",
            f"/sessions/{session_id}/rollback",
            json_body={"numTurns": num_turns},
            allow_statuses=(200, 400, 409, 410, 501),
        )

    def clean_background_terminals(self, *, session_id: str) -> Any:
        return self._request(
            "sessions.background_terminals.clean",
            "POST",
            f"/sessions/{session_id}/background-terminals/clean",
            allow_statuses=(200, 410, 501),
        )

    def review(
        self,
        *,
        session_id: str,
        delivery: Literal["inline", "detached"] | None = None,
        target_type: Literal["uncommittedChanges", "baseBranch", "commit", "custom"] | None = None,
        branch: str | None = None,
        sha: str | None = None,
        title: str | None = None,
        instructions: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.review",
            "POST",
            f"/sessions/{session_id}/review",
            json_body={
                "delivery": delivery,
                "targetType": target_type,
                "branch": branch,
                "sha": sha,
                "title": title,
                "instructions": instructions,
            },
            allow_statuses=(200, 410, 501),
        )

    def steer(self, *, session_id: str, turn_id: str, input_text: str) -> Any:
        return self._request(
            "sessions.steer",
            "POST",
            f"/sessions/{session_id}/turns/{turn_id}/steer",
            json_body={"input": input_text},
            allow_statuses=(200, 400, 404, 409, 410, 501),
        )

    def rename(self, *, session_id: str, title: str) -> Any:
        return self._request(
            "sessions.rename",
            "POST",
            f"/sessions/{session_id}/rename",
            json_body={"title": title},
        )

    def archive(self, *, session_id: str) -> Any:
        return self._request("sessions.archive", "POST", f"/sessions/{session_id}/archive")

    def unarchive(self, *, session_id: str) -> Any:
        return self._request("sessions.unarchive", "POST", f"/sessions/{session_id}/unarchive")

    def set_project(self, *, session_id: str, project_id: str | None) -> Any:
        return self._request(
            "sessions.project.set",
            "POST",
            f"/sessions/{session_id}/project",
            json_body={"projectId": project_id},
        )

    def approvals(self, *, session_id: str) -> Any:
        return self._request(
            "sessions.approvals.list",
            "GET",
            f"/sessions/{session_id}/approvals",
            allow_statuses=(200, 410),
        )

    def tool_input(self, *, session_id: str) -> Any:
        return self._request(
            "sessions.tool_input.list",
            "GET",
            f"/sessions/{session_id}/tool-input",
            allow_statuses=(200, 410),
        )

    def controls_get(self, *, session_id: str) -> Any:
        return self._request(
            "sessions.controls.get",
            "GET",
            f"/sessions/{session_id}/session-controls",
            allow_statuses=(200, 404, 410),
        )

    def controls_apply(
        self,
        *,
        session_id: str,
        controls: dict[str, Any],
        scope: str = "session",
        actor: str | None = None,
        source: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.controls.apply",
            "POST",
            f"/sessions/{session_id}/session-controls",
            json_body={"scope": scope, "actor": actor, "source": source, "controls": controls},
            allow_statuses=(200, 400, 404, 410, 423),
        )

    def settings_get(
        self,
        *,
        session_id: str,
        scope: SessionSettingsScopeName = "session",
        key: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.settings.get",
            "GET",
            f"/sessions/{session_id}/settings",
            query={"scope": scope, "key": key},
            allow_statuses=(200, 404, 410),
        )

    def settings_set(
        self,
        *,
        session_id: str,
        scope: SessionSettingsScopeName = "session",
        settings: dict[str, Any] | None = None,
        mode: str | None = "merge",
        key: str | None = None,
        value: Any | None = None,
        actor: str | None = None,
        source: str | None = None,
    ) -> Any:
        if settings is None and key is None:
            raise ValueError("settings_set requires either settings or key/value")
        if settings is not None and key is not None:
            raise ValueError("settings_set accepts either settings or key/value, not both")

        body: dict[str, Any] = {"scope": scope, "actor": actor, "source": source}
        if settings is not None:
            body["settings"] = settings
            body["mode"] = mode
        else:
            body["key"] = key
            body["value"] = value
        return self._request(
            "sessions.settings.set",
            "POST",
            f"/sessions/{session_id}/settings",
            json_body=body,
            allow_statuses=(200, 400, 404, 410, 423),
        )

    def settings_unset(
        self,
        *,
        session_id: str,
        key: str,
        scope: SessionSettingsScopeName = "session",
        actor: str | None = None,
        source: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.settings.unset",
            "DELETE",
            f"/sessions/{session_id}/settings/{key}",
            query={"scope": scope, "actor": actor, "source": source},
            allow_statuses=(200, 404, 410, 423),
        )

    def resume(self, *, session_id: str) -> Any:
        return self._request("sessions.resume", "POST", f"/sessions/{session_id}/resume", allow_statuses=(200, 410))

    def suggest_request(
        self,
        *,
        session_id: str,
        model: str | None = None,
        effort: ReasoningEffort | None = None,
        draft: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.suggest_request",
            "POST",
            f"/sessions/{session_id}/suggested-request",
            json_body={"model": model, "effort": effort, "draft": draft},
            allow_statuses=(200, 202, 409, 410),
        )

    def suggest_request_enqueue(
        self,
        *,
        session_id: str,
        model: str | None = None,
        effort: str | None = None,
        draft: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.suggest_request.enqueue",
            "POST",
            f"/sessions/{session_id}/suggested-request/jobs",
            json_body={"model": model, "effort": effort, "draft": draft},
            allow_statuses=(202, 404, 410),
        )

    def suggest_request_upsert(
        self,
        *,
        session_id: str,
        request_key: str,
        status: Literal["streaming", "complete", "error", "canceled"],
        suggestion: str | None = None,
        error: str | None = None,
    ) -> Any:
        return self._request(
            "sessions.suggest_request.upsert",
            "POST",
            f"/sessions/{session_id}/suggested-request/upsert",
            json_body={
                "requestKey": request_key,
                "status": status,
                "suggestion": suggestion,
                "error": error,
            },
        )

    def transcript_upsert(
        self,
        *,
        session_id: str,
        message_id: str,
        turn_id: str,
        role: str,
        entry_type: str,
        content: str,
        status: str,
        details: str | None = None,
        started_at: int | None = None,
        completed_at: int | None = None,
    ) -> Any:
        return self._request(
            "sessions.transcript.upsert",
            "POST",
            f"/sessions/{session_id}/transcript/upsert",
            json_body={
                "messageId": message_id,
                "turnId": turn_id,
                "role": role,
                "type": entry_type,
                "content": content,
                "status": status,
                "details": details,
                "startedAt": started_at,
                "completedAt": completed_at,
            },
            allow_statuses=(200, 404, 410),
        )

    def send_message(
        self,
        *,
        session_id: str,
        text: str,
        model: str | None = None,
        effort: ReasoningEffort | None = None,
        approval_policy: ApprovalPolicy | None = None,
        network_access: NetworkAccess | None = None,
        filesystem_sandbox: FilesystemSandbox | None = None,
    ) -> Any:
        return self._request(
            "sessions.send_message",
            "POST",
            f"/sessions/{session_id}/messages",
            json_body={
                "text": text,
                "model": model,
                "effort": effort,
                "approvalPolicy": approval_policy,
                "networkAccess": network_access,
                "filesystemSandbox": filesystem_sandbox,
            },
            allow_statuses=(202, 404, 410),
        )

    def interrupt(self, *, session_id: str, turn_id: str | None = None) -> Any:
        return self._request(
            "sessions.interrupt",
            "POST",
            f"/sessions/{session_id}/interrupt",
            json_body={"turnId": turn_id} if turn_id else {},
            allow_statuses=(200, 404, 409),
        )

    def approval_policy(self, *, session_id: str, approval_policy: ApprovalPolicy) -> Any:
        return self._request(
            "sessions.approval_policy.set",
            "POST",
            f"/sessions/{session_id}/approval-policy",
            json_body={"approvalPolicy": approval_policy},
            allow_statuses=(200, 404, 410),
        )


@dataclass(slots=True)
class SessionMessagesScope:
    sessions: SessionsApi
    session_id: str

    def send(self, text: str, **kwargs: Any) -> Any:
        return self.sessions.send_message(session_id=self.session_id, text=text, **kwargs)


@dataclass(slots=True)
class SessionControlsScope:
    sessions: SessionsApi
    session_id: str

    def get(self) -> Any:
        return self.sessions.controls_get(session_id=self.session_id)

    def apply(self, *, controls: dict[str, Any], scope: str = "session", actor: str | None = None, source: str | None = None) -> Any:
        return self.sessions.controls_apply(
            session_id=self.session_id,
            controls=controls,
            scope=scope,
            actor=actor,
            source=source,
        )


@dataclass(slots=True)
class SessionSettingsNamespace:
    settings_scope: "SessionSettingsScope"
    namespace: str

    def get(self, *, scope: str = "session") -> Any:
        parts = _namespace_parts(self.namespace)
        if not parts:
            return self.settings_scope.get(scope=scope)

        root_key = parts[0]
        response = self.settings_scope.get(scope=scope, key=root_key)
        value = response.get("value") if isinstance(response, dict) else None

        current: Any = value
        for part in parts[1:]:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
        return current

    def set(self, value: Any, *, scope: str = "session", mode: str = "merge") -> Any:
        parts = _namespace_parts(self.namespace)
        if not parts:
            if not isinstance(value, dict):
                raise ValueError("root namespace set requires dict value")
            return self.settings_scope.set(settings=value, scope=scope, mode=mode)

        root_key = parts[0]
        base_response = self.settings_scope.get(scope=scope, key=root_key)
        existing_root = base_response.get("value") if isinstance(base_response, dict) else None
        root_dict = _ensure_dict(existing_root)

        # Build a nested patch tree from dotted namespace segments
        # so updates can merge without clobbering sibling keys.
        patch: dict[str, Any] = {}
        cursor = patch
        for part in parts[1:-1]:
            next_dict: dict[str, Any] = {}
            cursor[part] = next_dict
            cursor = next_dict

        if len(parts) == 1:
            # Top-level namespaces can either merge object values
            # or replace the whole key with any JSON-compatible value.
            if isinstance(value, dict) and mode == "merge":
                root_dict = _deep_merge(root_dict, value)
                return self.settings_scope.set(key=root_key, value=root_dict, scope=scope)
            return self.settings_scope.set(key=root_key, value=value, scope=scope)

        # Nested namespaces always merge into the existing top-level root key.
        cursor[parts[-1]] = value
        merged_root = _deep_merge(root_dict, patch)
        return self.settings_scope.set(key=root_key, value=merged_root, scope=scope)

    def merge(self, patch: dict[str, Any], *, scope: str = "session") -> Any:
        if not isinstance(patch, dict):
            raise ValueError("merge patch must be a dict")

        current = self.get(scope=scope)
        current_dict = _ensure_dict(current)
        merged = _deep_merge(current_dict, patch)
        return self.set(merged, scope=scope)


@dataclass(slots=True)
class SessionSettingsScope:
    sessions: SessionsApi
    session_id: str

    def get(self, *, scope: SessionSettingsScopeName = "session", key: str | None = None) -> Any:
        return self.sessions.settings_get(session_id=self.session_id, scope=scope, key=key)

    def set(
        self,
        *,
        settings: dict[str, Any] | None = None,
        key: str | None = None,
        value: Any | None = None,
        scope: SessionSettingsScopeName = "session",
        mode: str = "merge",
        actor: str | None = None,
        source: str | None = None,
    ) -> Any:
        return self.sessions.settings_set(
            session_id=self.session_id,
            scope=scope,
            settings=settings,
            key=key,
            value=value,
            mode=mode,
            actor=actor,
            source=source,
        )

    def unset(
        self,
        key: str,
        *,
        scope: SessionSettingsScopeName = "session",
        actor: str | None = None,
        source: str | None = None,
    ) -> Any:
        return self.sessions.settings_unset(
            session_id=self.session_id,
            key=key,
            scope=scope,
            actor=actor,
            source=source,
        )

    def namespace(self, namespace: str) -> SessionSettingsNamespace:
        return SessionSettingsNamespace(settings_scope=self, namespace=namespace)


@dataclass(slots=True)
class SessionApprovalsScope:
    sessions: SessionsApi
    session_id: str

    def list(self) -> Any:
        return self.sessions.approvals(session_id=self.session_id)


@dataclass(slots=True)
class SessionToolInputScope:
    sessions: SessionsApi
    session_id: str

    def list(self) -> Any:
        return self.sessions.tool_input(session_id=self.session_id)


class SessionScope:
    def __init__(self, sessions: SessionsApi, session_id: str) -> None:
        self._sessions = sessions
        self.session_id = session_id
        self.messages = SessionMessagesScope(sessions=sessions, session_id=session_id)
        self.controls = SessionControlsScope(sessions=sessions, session_id=session_id)
        self.settings = SessionSettingsScope(sessions=sessions, session_id=session_id)
        self.approvals = SessionApprovalsScope(sessions=sessions, session_id=session_id)
        self.tool_input = SessionToolInputScope(sessions=sessions, session_id=session_id)

    def get(self) -> Any:
        return self._sessions.get(session_id=self.session_id)

    def rename(self, title: str) -> Any:
        return self._sessions.rename(session_id=self.session_id, title=title)

    def archive(self) -> Any:
        return self._sessions.archive(session_id=self.session_id)

    def unarchive(self) -> Any:
        return self._sessions.unarchive(session_id=self.session_id)

    def resume(self) -> Any:
        return self._sessions.resume(session_id=self.session_id)

    def send(self, text: str, **kwargs: Any) -> Any:
        return self._sessions.send_message(session_id=self.session_id, text=text, **kwargs)

    def interrupt(self) -> Any:
        return self._sessions.interrupt(session_id=self.session_id)

    def suggest_request(self, *, model: str | None = None, effort: ReasoningEffort | None = None, draft: str | None = None) -> Any:
        return self._sessions.suggest_request(session_id=self.session_id, model=model, effort=effort, draft=draft)
