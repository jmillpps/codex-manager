"""codex-manager Python client SDK.

This module uses lazy exports so lightweight utilities (for example config parsing)
can be imported without immediately importing transport dependencies.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

__all__ = [
    "AsyncClientPlugin",
    "ApiError",
    "ApprovalDecision",
    "ApprovalPolicy",
    "AppServerSignal",
    "AsyncHeaderProvider",
    "AsyncHookMiddleware",
    "AsyncRequestExecutor",
    "AsyncCodexManager",
    "AuthError",
    "ClientConfig",
    "ClientTimeoutError",
    "CodexManager",
    "CodexManagerError",
    "ConflictError",
    "FilesystemSandbox",
    "GoneError",
    "LockedError",
    "NetworkAccess",
    "NotFoundError",
    "PluginLifecycle",
    "PluginRegistry",
    "ReasoningEffort",
    "RetryPolicy",
    "ServerError",
    "SessionSettingsScopeName",
    "StreamHandler",
    "StreamMatcher",
    "StreamRouter",
    "StreamEvent",
    "SyncClientPlugin",
    "SyncHeaderProvider",
    "SyncHookMiddleware",
    "SyncRequestExecutor",
    "ValidationMode",
    "TypedModelValidationError",
    "ToolInputDecision",
    "TransportError",
    "ValidationError",
]

_EXPORTS: dict[str, tuple[str, str]] = {
    "AsyncCodexManager": (".client", "AsyncCodexManager"),
    "CodexManager": (".client", "CodexManager"),
    "ValidationMode": (".client", "ValidationMode"),
    "ClientConfig": (".config", "ClientConfig"),
    "ApiError": (".errors", "ApiError"),
    "AuthError": (".errors", "AuthError"),
    "ClientTimeoutError": (".errors", "ClientTimeoutError"),
    "CodexManagerError": (".errors", "CodexManagerError"),
    "ConflictError": (".errors", "ConflictError"),
    "GoneError": (".errors", "GoneError"),
    "LockedError": (".errors", "LockedError"),
    "NotFoundError": (".errors", "NotFoundError"),
    "ServerError": (".errors", "ServerError"),
    "TypedModelValidationError": (".errors", "TypedModelValidationError"),
    "TransportError": (".errors", "TransportError"),
    "ValidationError": (".errors", "ValidationError"),
    "AppServerSignal": (".models", "AppServerSignal"),
    "StreamEvent": (".models", "StreamEvent"),
    "ApprovalDecision": (".api", "ApprovalDecision"),
    "ApprovalPolicy": (".api", "ApprovalPolicy"),
    "FilesystemSandbox": (".api", "FilesystemSandbox"),
    "NetworkAccess": (".api", "NetworkAccess"),
    "ReasoningEffort": (".api", "ReasoningEffort"),
    "SessionSettingsScopeName": (".api", "SessionSettingsScopeName"),
    "ToolInputDecision": (".api", "ToolInputDecision"),
    "PluginRegistry": (".plugins", "PluginRegistry"),
    "AsyncRequestExecutor": (".protocols", "AsyncRequestExecutor"),
    "SyncRequestExecutor": (".protocols", "SyncRequestExecutor"),
    "AsyncHeaderProvider": (".protocols", "AsyncHeaderProvider"),
    "SyncHeaderProvider": (".protocols", "SyncHeaderProvider"),
    "RetryPolicy": (".protocols", "RetryPolicy"),
    "AsyncHookMiddleware": (".protocols", "AsyncHookMiddleware"),
    "SyncHookMiddleware": (".protocols", "SyncHookMiddleware"),
    "StreamMatcher": (".protocols", "StreamMatcher"),
    "StreamHandler": (".protocols", "StreamHandler"),
    "StreamRouter": (".protocols", "StreamRouter"),
    "AsyncClientPlugin": (".protocols", "AsyncClientPlugin"),
    "SyncClientPlugin": (".protocols", "SyncClientPlugin"),
    "PluginLifecycle": (".protocols", "PluginLifecycle"),
}

if TYPE_CHECKING:
    from .api import (
        ApprovalDecision,
        ApprovalPolicy,
        FilesystemSandbox,
        NetworkAccess,
        ReasoningEffort,
        SessionSettingsScopeName,
        ToolInputDecision,
    )
    from .client import AsyncCodexManager, CodexManager, ValidationMode
    from .config import ClientConfig
    from .errors import (
        ApiError,
        AuthError,
        ClientTimeoutError,
        CodexManagerError,
        ConflictError,
        GoneError,
        LockedError,
        NotFoundError,
        ServerError,
        TypedModelValidationError,
        TransportError,
        ValidationError,
    )
    from .models import AppServerSignal, StreamEvent
    from .plugins import PluginRegistry
    from .protocols import (
        AsyncClientPlugin,
        AsyncHeaderProvider,
        AsyncHookMiddleware,
        AsyncRequestExecutor,
        PluginLifecycle,
        RetryPolicy,
        StreamHandler,
        StreamMatcher,
        StreamRouter,
        SyncClientPlugin,
        SyncHeaderProvider,
        SyncHookMiddleware,
        SyncRequestExecutor,
    )


def __getattr__(name: str) -> Any:
    module_info = _EXPORTS.get(name)
    if module_info is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attribute = module_info
    module = import_module(module_name, __name__)
    value = getattr(module, attribute)
    globals()[name] = value
    return value
