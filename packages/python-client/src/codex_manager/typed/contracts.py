"""Typed operation contracts for OpenAPI-backed Python facades."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from ..generated import (
    ApiValidationError,
    ApprovalDecisionErrorResponse,
    ApprovalDecisionNotFoundResponse,
    ApprovalDecisionReconciledResponse,
    ApprovalDecisionRequest,
    ApprovalDecisionSuccessResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    DeletedSessionPayload,
    QueueErrorResponse,
    ReadSessionResponse,
    SendSessionMessageAcceptedResponse,
    SendSessionMessageRequest,
    SessionNotFoundPayload,
    SessionSettingsDeleteResponse,
    SessionSettingsGetResponse,
    SessionSettingsLockedResponse,
    SessionSettingsSetResponse,
    SetSessionSettingsRequest,
    SuggestedRequestBody,
    SuggestedRequestQueuedResponse,
    SuggestedRequestUpsertBody,
    SuggestedRequestUpsertErrorResponse,
    SuggestedRequestUpsertResponse,
    SuggestSessionRequestNoContextResponse,
    SuggestSessionRequestSuccessResponse,
    SystemSessionError,
    ToolInputDecisionErrorResponse,
    ToolInputDecisionNotFoundResponse,
    ToolInputDecisionRequest,
    ToolInputDecisionSuccessResponse,
)


@dataclass(frozen=True, slots=True)
class TypedOperationContract:
    operation_key: str
    operation_id: str
    request_model: type[BaseModel] | None
    response_models: tuple[Any, ...]


TYPED_OPERATION_CONTRACTS: dict[str, TypedOperationContract] = {
    "sessions.create": TypedOperationContract(
        operation_key="sessions.create",
        operation_id="createSession",
        request_model=CreateSessionRequest,
        response_models=(CreateSessionResponse,),
    ),
    "sessions.get": TypedOperationContract(
        operation_key="sessions.get",
        operation_id="readSession",
        request_model=None,
        response_models=(ReadSessionResponse, DeletedSessionPayload),
    ),
    "sessions.send_message": TypedOperationContract(
        operation_key="sessions.send_message",
        operation_id="sendSessionMessage",
        request_model=SendSessionMessageRequest,
        response_models=(
            SendSessionMessageAcceptedResponse,
            ApiValidationError,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
        ),
    ),
    "sessions.settings.get": TypedOperationContract(
        operation_key="sessions.settings.get",
        operation_id="getSessionSettings",
        request_model=None,
        response_models=(
            SessionSettingsGetResponse,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
        ),
    ),
    "sessions.settings.set": TypedOperationContract(
        operation_key="sessions.settings.set",
        operation_id="setSessionSettings",
        request_model=SetSessionSettingsRequest,
        response_models=(
            SessionSettingsSetResponse,
            ApiValidationError,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
            SessionSettingsLockedResponse,
        ),
    ),
    "sessions.settings.unset": TypedOperationContract(
        operation_key="sessions.settings.unset",
        operation_id="deleteSessionSetting",
        request_model=None,
        response_models=(
            SessionSettingsDeleteResponse,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
            SessionSettingsLockedResponse,
        ),
    ),
    "sessions.suggest_request": TypedOperationContract(
        operation_key="sessions.suggest_request",
        operation_id="suggestSessionRequest",
        request_model=SuggestedRequestBody,
        response_models=(
            SuggestSessionRequestSuccessResponse,
            SuggestedRequestQueuedResponse,
            ApiValidationError,
            SystemSessionError,
            SessionNotFoundPayload,
            SuggestSessionRequestNoContextResponse,
            DeletedSessionPayload,
            QueueErrorResponse,
        ),
    ),
    "sessions.suggest_request.enqueue": TypedOperationContract(
        operation_key="sessions.suggest_request.enqueue",
        operation_id="enqueueSuggestedSessionRequest",
        request_model=SuggestedRequestBody,
        response_models=(
            SuggestedRequestQueuedResponse,
            ApiValidationError,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
            QueueErrorResponse,
        ),
    ),
    "sessions.suggest_request.upsert": TypedOperationContract(
        operation_key="sessions.suggest_request.upsert",
        operation_id="upsertSuggestedSessionRequest",
        request_model=SuggestedRequestUpsertBody,
        response_models=(
            SuggestedRequestUpsertResponse,
            SuggestedRequestUpsertErrorResponse,
            SystemSessionError,
            SessionNotFoundPayload,
            DeletedSessionPayload,
        ),
    ),
    "approvals.decide": TypedOperationContract(
        operation_key="approvals.decide",
        operation_id="decideApproval",
        request_model=ApprovalDecisionRequest,
        response_models=(
            ApprovalDecisionSuccessResponse,
            ApprovalDecisionNotFoundResponse,
            ApprovalDecisionReconciledResponse,
            ApprovalDecisionErrorResponse,
        ),
    ),
    "tool_input.decide": TypedOperationContract(
        operation_key="tool_input.decide",
        operation_id="decideToolInput",
        request_model=ToolInputDecisionRequest,
        response_models=(
            ToolInputDecisionSuccessResponse,
            ToolInputDecisionNotFoundResponse,
            ToolInputDecisionErrorResponse,
        ),
    ),
}


TYPED_OPERATION_IDS: set[str] = {
    contract.operation_id for contract in TYPED_OPERATION_CONTRACTS.values()
}

STRICT_VALIDATION_OPERATION_KEYS: set[str] = {
    "sessions.create",
    "sessions.get",
    "sessions.send_message",
    "sessions.settings.get",
    "sessions.settings.set",
    "sessions.settings.unset",
    "sessions.suggest_request",
    "sessions.suggest_request.enqueue",
    "sessions.suggest_request.upsert",
    "approvals.decide",
    "tool_input.decide",
}

ALL_OPENAPI_OPERATION_IDS: set[str] = {
    "applySessionControls",
    "archiveSession",
    "cancelAccountLogin",
    "cancelOrchestratorJob",
    "cleanBackgroundTerminals",
    "compactSession",
    "connectEventStream",
    "createProject",
    "createSession",
    "decideApproval",
    "decideToolInput",
    "deleteProject",
    "deleteProjectChats",
    "deleteSession",
    "deleteSessionSetting",
    "enqueueSuggestedSessionRequest",
    "executeCommand",
    "forkSession",
    "getApiInfo",
    "getCapabilities",
    "getHealth",
    "getOrchestratorJob",
    "getSessionControls",
    "getSessionSettings",
    "interruptSessionTurn",
    "listAgentExtensions",
    "listApps",
    "listCollaborationModes",
    "listExperimentalFeatures",
    "listMcpServers",
    "listModels",
    "listProjectAgentSessions",
    "listProjectOrchestratorJobs",
    "listProjects",
    "listSessionApprovals",
    "listSessionToolCalls",
    "listSessionToolInput",
    "listSessions",
    "listSkills",
    "logoutAccount",
    "moveProjectChats",
    "readAccount",
    "readAccountRateLimits",
    "readConfig",
    "readConfigRequirements",
    "readRemoteSkills",
    "readSession",
    "reloadAgentExtensions",
    "reloadMcpConfig",
    "renameProject",
    "renameSession",
    "respondToolCall",
    "resumeSession",
    "rollbackSession",
    "sendSessionMessage",
    "setSessionApprovalPolicy",
    "setSessionProject",
    "setSessionSettings",
    "startAccountLogin",
    "startMcpOauthLogin",
    "startReview",
    "steerTurn",
    "suggestSessionRequest",
    "unarchiveSession",
    "uploadFeedback",
    "upsertSessionTranscriptEntry",
    "upsertSuggestedSessionRequest",
    "writeConfigBatch",
    "writeConfigValue",
    "writeRemoteSkills",
    "writeSkillConfig",
}

RAW_OPERATION_IDS: set[str] = ALL_OPENAPI_OPERATION_IDS - TYPED_OPERATION_IDS
