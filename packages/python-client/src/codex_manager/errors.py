"""Error hierarchy for codex-manager Python client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class RequestDetails:
    operation: str
    method: str
    path: str
    status_code: int | None = None
    response_body: Any | None = None


class CodexManagerError(Exception):
    """Base class for all client errors."""


class TransportError(CodexManagerError):
    """Raised on network/transport failures."""


class ApiError(CodexManagerError):
    """Raised when API returns an unexpected HTTP status."""

    def __init__(self, message: str, *, details: RequestDetails) -> None:
        super().__init__(message)
        self.details = details


class AuthError(ApiError):
    """Raised for authentication/authorization failures."""


class ValidationError(ApiError):
    """Raised for invalid request payloads."""


class NotFoundError(ApiError):
    """Raised when requested resource does not exist."""


class ConflictError(ApiError):
    """Raised when request conflicts with current state."""


class GoneError(ApiError):
    """Raised when resource is gone/purged."""


class LockedError(ApiError):
    """Raised when settings/defaults are locked by policy."""


class ServerError(ApiError):
    """Raised for server-side failures."""


class ClientTimeoutError(TransportError):
    """Raised when request times out."""


class TypedModelValidationError(CodexManagerError):
    """Raised when typed request/response parsing fails validation."""

    def __init__(
        self,
        *,
        operation: str,
        model_name: str,
        errors: Any,
        boundary: str | None = None,
        status_code: int | None = None,
        raw_sample: Any | None = None,
    ) -> None:
        location = boundary or "boundary"
        super().__init__(f"{operation} {location} validation failed for {model_name}")
        self.operation = operation
        self.model_name = model_name
        self.errors = errors
        self.boundary = boundary
        self.status_code = status_code
        self.raw_sample = raw_sample


class WaitTimeoutError(CodexManagerError):
    """Raised when a wait helper times out before predicate match."""


def classify_api_error(details: RequestDetails) -> ApiError:
    status = details.status_code or 0
    message = f"{details.operation} failed with status {status}"

    if status in (401, 403):
        return AuthError(message, details=details)
    if status == 400:
        return ValidationError(message, details=details)
    if status == 404:
        return NotFoundError(message, details=details)
    if status == 409:
        return ConflictError(message, details=details)
    if status == 410:
        return GoneError(message, details=details)
    if status == 423:
        return LockedError(message, details=details)
    if status >= 500:
        return ServerError(message, details=details)

    return ApiError(message, details=details)
