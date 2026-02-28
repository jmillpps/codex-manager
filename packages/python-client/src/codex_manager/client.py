"""Top-level codex-manager clients (sync + async)."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Callable, Iterable, Literal

import httpx

from .api import (
    AccountApi,
    AppsApi,
    ApprovalsApi,
    ConfigApi,
    ExtensionsApi,
    FeedbackApi,
    McpApi,
    ModelsApi,
    OrchestratorApi,
    ProjectsApi,
    RawApi,
    SessionScope,
    SessionsApi,
    SkillsApi,
    SystemApi,
    ToolInputApi,
)
from .config import ClientConfig
from .errors import ApiError, TypedModelValidationError
from .hooks import HookRegistry, RequestCall
from .plugins import PluginRegistry
from .protocols import (
    AsyncClientPlugin,
    AsyncHeaderProvider,
    AsyncHookMiddleware,
    AsyncRequestExecutor,
    RetryPolicy,
    StreamRouter,
    SyncClientPlugin,
    SyncHeaderProvider,
    SyncHookMiddleware,
    SyncRequestExecutor,
)
from .stream import AsyncEventStream, SyncEventStream
from .transport import AsyncTransport, SyncTransport
from .typed.client import AsyncTypedCodexManagerFacade, TypedCodexManagerFacade, parse_response_for_operation
from .typed.contracts import STRICT_VALIDATION_OPERATION_KEYS

_RETRY_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
_VALIDATION_MODE_ENV = "CODEX_MANAGER_PY_VALIDATION_MODE"
_VALIDATION_MODES = {"typed-only", "off", "strict"}
ValidationMode = Literal["typed-only", "off", "strict"]


def _normalize_path(path: str, api_prefix: str) -> str:
    if not path:
        return ""

    normalized = path if path.startswith("/") else f"/{path}"
    # Accept both "/api/..." and "/..." caller paths while keeping a single
    # transport prefix configuration. This lets raw calls use full API paths
    # without double-prefixing.
    prefix = api_prefix.rstrip("/")
    if prefix and normalized.startswith(prefix + "/"):
        return normalized[len(prefix) :]
    if prefix and normalized == prefix:
        return ""
    return normalized


def _extract_status_code(error: Exception) -> int | None:
    if isinstance(error, ApiError):
        return error.details.status_code
    return None


def _normalize_validation_mode(value: str | None) -> ValidationMode:
    if value is None or value.strip() == "":
        return "typed-only"
    normalized = value.strip().lower()
    if normalized in _VALIDATION_MODES:
        return normalized  # type: ignore[return-value]
    raise ValueError(f"invalid validation_mode {value!r}; expected one of: typed-only, off, strict")


class CodexManager:
    """Synchronous codex-manager client."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:3001",
        api_prefix: str = "/api",
        timeout_seconds: float = 30.0,
        headers: dict[str, str] | None = None,
        http_client: httpx.Client | None = None,
        request_executor: SyncRequestExecutor | None = None,
        header_provider: SyncHeaderProvider | None = None,
        retry_policy: RetryPolicy | None = None,
        retryable_operations: Iterable[str] | None = None,
        hook_registry: HookRegistry | None = None,
        stream_router: StreamRouter | None = None,
        plugins: Iterable[SyncClientPlugin] | None = None,
        validation_mode: ValidationMode | None = None,
    ) -> None:
        self.client_config = ClientConfig(
            base_url=base_url,
            api_prefix=api_prefix,
            timeout_seconds=timeout_seconds,
            headers=dict(headers or {}),
        )
        self._hooks = hook_registry or HookRegistry()
        self._header_provider = header_provider
        self._retry_policy = retry_policy
        self._retryable_operations = set(retryable_operations or ())
        configured_mode = validation_mode if validation_mode is not None else os.getenv(_VALIDATION_MODE_ENV)
        self._validation_mode = _normalize_validation_mode(configured_mode)

        self._client = http_client or httpx.Client(
            base_url=self.client_config.base_url,
            timeout=self.client_config.timeout_seconds,
            headers=self.client_config.headers,
        )
        self._transport = SyncTransport(self._client, self.client_config.api_prefix)
        self._executor = request_executor or self._transport

        self.system = SystemApi(self._request)
        self.models = ModelsApi(self._request)
        self.apps = AppsApi(self._request)
        self.skills = SkillsApi(self._request)
        self.mcp = McpApi(self._request)
        self.account = AccountApi(self._request)
        self.config = ConfigApi(self._request)
        self.runtime = RuntimeApiAdapter(self._request)
        self.feedback = FeedbackApi(self._request)
        self.extensions = ExtensionsApi(self._request)
        self.orchestrator = OrchestratorApi(self._request)
        self.projects = ProjectsApi(self._request)
        self.sessions = SessionsApi(self._request)
        self.approvals = ApprovalsApi(self._request)
        self.tool_input = ToolInputApi(self._request)
        self.raw = RawApi(self._request)
        self.typed = TypedCodexManagerFacade(self)

        async_stream = AsyncEventStream(
            base_url=self.client_config.base_url,
            api_prefix=self.client_config.api_prefix,
            headers=self.client_config.headers,
            router=stream_router,
        )
        self.stream = SyncEventStream(async_stream)

        self._plugins = PluginRegistry()
        try:
            self._plugins.register_sync(self, plugins or ())
        except Exception:
            self._client.close()
            raise

    @classmethod
    def from_env(cls) -> "CodexManager":
        cfg = ClientConfig.from_env()
        return cls(
            base_url=cfg.base_url,
            api_prefix=cfg.api_prefix,
            timeout_seconds=cfg.timeout_seconds,
            headers=cfg.headers,
        )

    @classmethod
    def from_profile(cls, profile: str | None = None) -> "CodexManager":
        cfg = ClientConfig.from_profile(profile)
        return cls(
            base_url=cfg.base_url,
            api_prefix=cfg.api_prefix,
            timeout_seconds=cfg.timeout_seconds,
            headers=cfg.headers,
        )

    def session(self, session_id: str) -> SessionScope:
        return SessionScope(self.sessions, session_id)

    def before(self, operation: str = "*") -> Callable[[Callable[[RequestCall], Any]], Callable[[RequestCall], Any]]:
        def decorator(func: Callable[[RequestCall], Any]) -> Callable[[RequestCall], Any]:
            self._hooks.add_before(operation, func)
            return func

        return decorator

    def after(self, operation: str = "*") -> Callable[[Callable[[RequestCall, Any], Any]], Callable[[RequestCall, Any], Any]]:
        def decorator(func: Callable[[RequestCall, Any], Any]) -> Callable[[RequestCall, Any], Any]:
            self._hooks.add_after(operation, func)
            return func

        return decorator

    def on_error(self, operation: str = "*") -> Callable[[Callable[[RequestCall, Exception], Any]], Callable[[RequestCall, Exception], Any]]:
        def decorator(func: Callable[[RequestCall, Exception], Any]) -> Callable[[RequestCall, Exception], Any]:
            self._hooks.add_error(operation, func)
            return func

        return decorator

    def use_middleware(self, middleware: SyncHookMiddleware | AsyncHookMiddleware, *, operation: str = "*") -> None:
        self._hooks.add_middleware(operation, middleware)

    def on_event(self, event_type: str):
        return self.stream.on_event(event_type)

    def on_event_prefix(self, prefix: str):
        return self.stream.on_event_prefix(prefix)

    def on_app_server(self, normalized_method: str):
        return self.stream.on_app_server(normalized_method)

    def on_app_server_request(self, normalized_method: str):
        return self.stream.on_app_server_request(normalized_method)

    def on_turn_started(self):
        return self.stream.on_turn_started()

    def close(self) -> None:
        self._plugins.stop()
        self._client.close()

    def __enter__(self) -> "CodexManager":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _merge_provider_headers(self, request_headers: dict[str, str] | None) -> dict[str, str] | None:
        merged = dict(request_headers or {})
        if self._header_provider is None:
            return merged or None

        provider_headers = self._header_provider.headers()
        if provider_headers:
            return {**provider_headers, **merged}
        return merged or None

    def _is_retry_allowed(self, *, operation: str, method: str) -> bool:
        if method in _RETRY_SAFE_METHODS:
            return True
        return operation in self._retryable_operations

    def _strict_validate_response(self, operation: str, response: Any) -> None:
        if self._validation_mode != "strict":
            return
        if operation not in STRICT_VALIDATION_OPERATION_KEYS:
            return
        parse_response_for_operation(operation, response, status_code=None)

    def _request(
        self,
        operation: str,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any:
        call = RequestCall(
            operation=operation,
            method=method.upper(),
            path=_normalize_path(path, self.client_config.api_prefix),
            query=dict(query or {}),
            json_body=json_body,
            headers=dict(headers or {}),
        )

        self._hooks.run_before(call)

        attempt = 1
        while True:
            try:
                response = self._executor.request(
                    operation=call.operation,
                    method=call.method,
                    path=call.path,
                    query=call.query,
                    json_body=call.json_body,
                    headers=self._merge_provider_headers(call.headers),
                    allow_statuses=allow_statuses,
                )
                self._strict_validate_response(call.operation, response)
                self._hooks.run_after(call, response)
                return response
            except TypedModelValidationError as error:
                self._hooks.run_error(call, error)
                raise
            except Exception as error:
                if self._retry_policy is None or not self._is_retry_allowed(operation=call.operation, method=call.method):
                    self._hooks.run_error(call, error)
                    raise

                try:
                    should_retry = self._retry_policy.should_retry(
                        attempt=attempt,
                        error=error,
                        status_code=_extract_status_code(error),
                    )
                except Exception as policy_error:
                    self._hooks.run_error(call, policy_error)
                    raise
                if not should_retry:
                    self._hooks.run_error(call, error)
                    raise

                try:
                    delay = self._retry_policy.next_delay_seconds(attempt=attempt)
                except Exception as policy_error:
                    self._hooks.run_error(call, policy_error)
                    raise
                if delay > 0:
                    time.sleep(delay)
                attempt += 1


class AsyncCodexManager:
    """Asynchronous codex-manager client."""

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:3001",
        api_prefix: str = "/api",
        timeout_seconds: float = 30.0,
        headers: dict[str, str] | None = None,
        http_client: httpx.AsyncClient | None = None,
        request_executor: AsyncRequestExecutor | None = None,
        header_provider: AsyncHeaderProvider | None = None,
        retry_policy: RetryPolicy | None = None,
        retryable_operations: Iterable[str] | None = None,
        hook_registry: HookRegistry | None = None,
        stream_router: StreamRouter | None = None,
        plugins: Iterable[AsyncClientPlugin] | None = None,
        validation_mode: ValidationMode | None = None,
    ) -> None:
        self.client_config = ClientConfig(
            base_url=base_url,
            api_prefix=api_prefix,
            timeout_seconds=timeout_seconds,
            headers=dict(headers or {}),
        )
        self._hooks = hook_registry or HookRegistry()
        self._header_provider = header_provider
        self._retry_policy = retry_policy
        self._retryable_operations = set(retryable_operations or ())
        configured_mode = validation_mode if validation_mode is not None else os.getenv(_VALIDATION_MODE_ENV)
        self._validation_mode = _normalize_validation_mode(configured_mode)

        self._client = http_client or httpx.AsyncClient(
            base_url=self.client_config.base_url,
            timeout=self.client_config.timeout_seconds,
            headers=self.client_config.headers,
        )
        self._transport = AsyncTransport(self._client, self.client_config.api_prefix)
        self._executor = request_executor or self._transport

        self.system = SystemApi(self._request)
        self.models = ModelsApi(self._request)
        self.apps = AppsApi(self._request)
        self.skills = SkillsApi(self._request)
        self.mcp = McpApi(self._request)
        self.account = AccountApi(self._request)
        self.config = ConfigApi(self._request)
        self.runtime = RuntimeApiAdapter(self._request)
        self.feedback = FeedbackApi(self._request)
        self.extensions = ExtensionsApi(self._request)
        self.orchestrator = OrchestratorApi(self._request)
        self.projects = ProjectsApi(self._request)
        self.sessions = SessionsApi(self._request)
        self.approvals = ApprovalsApi(self._request)
        self.tool_input = ToolInputApi(self._request)
        self.raw = RawApi(self._request)
        self.typed = AsyncTypedCodexManagerFacade(self)

        self.stream = AsyncEventStream(
            base_url=self.client_config.base_url,
            api_prefix=self.client_config.api_prefix,
            headers=self.client_config.headers,
            router=stream_router,
        )

        self._plugins = PluginRegistry()
        try:
            self._plugins.register_async(self, plugins or ())
        except Exception:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                asyncio.run(self._client.aclose())
            else:
                loop.create_task(self._client.aclose())
            raise

    @classmethod
    def from_env(cls) -> "AsyncCodexManager":
        cfg = ClientConfig.from_env()
        return cls(
            base_url=cfg.base_url,
            api_prefix=cfg.api_prefix,
            timeout_seconds=cfg.timeout_seconds,
            headers=cfg.headers,
        )

    @classmethod
    def from_profile(cls, profile: str | None = None) -> "AsyncCodexManager":
        cfg = ClientConfig.from_profile(profile)
        return cls(
            base_url=cfg.base_url,
            api_prefix=cfg.api_prefix,
            timeout_seconds=cfg.timeout_seconds,
            headers=cfg.headers,
        )

    def session(self, session_id: str) -> SessionScope:
        return SessionScope(self.sessions, session_id)

    def before(self, operation: str = "*") -> Callable[[Callable[[RequestCall], Any]], Callable[[RequestCall], Any]]:
        def decorator(func: Callable[[RequestCall], Any]) -> Callable[[RequestCall], Any]:
            self._hooks.add_before(operation, func)
            return func

        return decorator

    def after(self, operation: str = "*") -> Callable[[Callable[[RequestCall, Any], Any]], Callable[[RequestCall, Any], Any]]:
        def decorator(func: Callable[[RequestCall, Any], Any]) -> Callable[[RequestCall, Any], Any]:
            self._hooks.add_after(operation, func)
            return func

        return decorator

    def on_error(self, operation: str = "*") -> Callable[[Callable[[RequestCall, Exception], Any]], Callable[[RequestCall, Exception], Any]]:
        def decorator(func: Callable[[RequestCall, Exception], Any]) -> Callable[[RequestCall, Exception], Any]:
            self._hooks.add_error(operation, func)
            return func

        return decorator

    def use_middleware(self, middleware: SyncHookMiddleware | AsyncHookMiddleware, *, operation: str = "*") -> None:
        self._hooks.add_middleware(operation, middleware)

    def on_event(self, event_type: str):
        return self.stream.on_event(event_type)

    def on_event_prefix(self, prefix: str):
        return self.stream.on_event_prefix(prefix)

    def on_app_server(self, normalized_method: str):
        return self.stream.on_app_server(normalized_method)

    def on_app_server_request(self, normalized_method: str):
        return self.stream.on_app_server_request(normalized_method)

    def on_turn_started(self):
        return self.stream.on_turn_started()

    async def close(self) -> None:
        self._plugins.stop()
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncCodexManager":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def _merge_provider_headers(self, request_headers: dict[str, str] | None) -> dict[str, str] | None:
        merged = dict(request_headers or {})
        if self._header_provider is None:
            return merged or None

        provider_headers = await self._header_provider.headers()
        if provider_headers:
            return {**provider_headers, **merged}
        return merged or None

    def _is_retry_allowed(self, *, operation: str, method: str) -> bool:
        if method in _RETRY_SAFE_METHODS:
            return True
        return operation in self._retryable_operations

    def _strict_validate_response(self, operation: str, response: Any) -> None:
        if self._validation_mode != "strict":
            return
        if operation not in STRICT_VALIDATION_OPERATION_KEYS:
            return
        parse_response_for_operation(operation, response, status_code=None)

    async def _request(
        self,
        operation: str,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any:
        call = RequestCall(
            operation=operation,
            method=method.upper(),
            path=_normalize_path(path, self.client_config.api_prefix),
            query=dict(query or {}),
            json_body=json_body,
            headers=dict(headers or {}),
        )

        await self._hooks.run_before_async(call)

        attempt = 1
        while True:
            try:
                response = await self._executor.request(
                    operation=call.operation,
                    method=call.method,
                    path=call.path,
                    query=call.query,
                    json_body=call.json_body,
                    headers=await self._merge_provider_headers(call.headers),
                    allow_statuses=allow_statuses,
                )
                self._strict_validate_response(call.operation, response)
                await self._hooks.run_after_async(call, response)
                return response
            except TypedModelValidationError as error:
                await self._hooks.run_error_async(call, error)
                raise
            except Exception as error:
                if self._retry_policy is None or not self._is_retry_allowed(operation=call.operation, method=call.method):
                    await self._hooks.run_error_async(call, error)
                    raise

                try:
                    should_retry = self._retry_policy.should_retry(
                        attempt=attempt,
                        error=error,
                        status_code=_extract_status_code(error),
                    )
                except Exception as policy_error:
                    await self._hooks.run_error_async(call, policy_error)
                    raise
                if not should_retry:
                    await self._hooks.run_error_async(call, error)
                    raise

                try:
                    delay = self._retry_policy.next_delay_seconds(attempt=attempt)
                except Exception as policy_error:
                    await self._hooks.run_error_async(call, policy_error)
                    raise
                if delay > 0:
                    await asyncio.sleep(delay)
                attempt += 1


class RuntimeApiAdapter:
    """Small adapter to preserve `client.runtime.exec(...)` naming."""

    def __init__(self, request: Callable[..., Any]) -> None:
        from .api import RuntimeApi

        self._runtime = RuntimeApi(request)

    def exec(self, *, command: list[str], cwd: str | None = None, timeout_ms: int | None = None) -> Any:
        return self._runtime.exec(command=command, cwd=cwd, timeout_ms=timeout_ms)
