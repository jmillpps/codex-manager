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
    "RemoteSkill",
    "RemoteSkillDispatch",
    "RemoteSkillSendResult",
    "RemoteSkillLifecycle",
    "RemoteSkillSession",
    "RemoteSkillsFacade",
    "AsyncRemoteSkillLifecycle",
    "AsyncRemoteSkillSession",
    "AsyncRemoteSkillsFacade",
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
    "WaitApi",
    "AsyncWaitApi",
    "SessionTurnReply",
    "WaitTimeoutError",
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
    "WaitTimeoutError": (".errors", "WaitTimeoutError"),
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
    "RemoteSkill": (".remote_skills", "RemoteSkill"),
    "RemoteSkillDispatch": (".remote_skills", "RemoteSkillDispatch"),
    "RemoteSkillSendResult": (".remote_skills", "RemoteSkillSendResult"),
    "RemoteSkillLifecycle": (".remote_skills", "RemoteSkillLifecycle"),
    "RemoteSkillSession": (".remote_skills", "RemoteSkillSession"),
    "RemoteSkillsFacade": (".remote_skills", "RemoteSkillsFacade"),
    "AsyncRemoteSkillLifecycle": (".remote_skills", "AsyncRemoteSkillLifecycle"),
    "AsyncRemoteSkillSession": (".remote_skills", "AsyncRemoteSkillSession"),
    "AsyncRemoteSkillsFacade": (".remote_skills", "AsyncRemoteSkillsFacade"),
    "WaitApi": (".wait", "WaitApi"),
    "AsyncWaitApi": (".wait", "AsyncWaitApi"),
    "SessionTurnReply": (".wait", "SessionTurnReply"),
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
        TransportError,
        TypedModelValidationError,
        ValidationError,
        WaitTimeoutError,
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
    from .remote_skills import (
        AsyncRemoteSkillLifecycle,
        AsyncRemoteSkillSession,
        AsyncRemoteSkillsFacade,
        RemoteSkill,
        RemoteSkillDispatch,
        RemoteSkillLifecycle,
        RemoteSkillSendResult,
        RemoteSkillSession,
        RemoteSkillsFacade,
    )
    from .wait import AsyncWaitApi, SessionTurnReply, WaitApi


def __getattr__(name: str) -> Any:
    module_info = _EXPORTS.get(name)
    if module_info is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    module_name, attribute = module_info
    module = import_module(module_name, __name__)
    value = getattr(module, attribute)
    globals()[name] = value
    return value
