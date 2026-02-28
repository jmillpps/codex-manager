"""Typed OpenAPI facade and generated request/response models."""

from __future__ import annotations

from ..generated import *  # noqa: F401,F403
from ..generated import __all__ as _generated_all
from .client import (
    AsyncTypedCodexManagerFacade,
    TypedCodexManagerFacade,
    TypedValidationMode,
    parse_response_for_operation,
)
from .contracts import (
    ALL_OPENAPI_OPERATION_IDS,
    RAW_OPERATION_IDS,
    STRICT_VALIDATION_OPERATION_KEYS,
    TYPED_OPERATION_CONTRACTS,
    TYPED_OPERATION_IDS,
    TypedOperationContract,
)

__all__ = [
    *_generated_all,
    "ALL_OPENAPI_OPERATION_IDS",
    "AsyncTypedCodexManagerFacade",
    "RAW_OPERATION_IDS",
    "STRICT_VALIDATION_OPERATION_KEYS",
    "TypedValidationMode",
    "TYPED_OPERATION_CONTRACTS",
    "TYPED_OPERATION_IDS",
    "TypedCodexManagerFacade",
    "TypedOperationContract",
    "parse_response_for_operation",
]
