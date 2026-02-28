"""HTTP transport for codex-manager client."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from json import JSONDecodeError
from typing import Any
from urllib.parse import urlencode

import httpx

from .errors import ClientTimeoutError, RequestDetails, TransportError, classify_api_error


@dataclass(slots=True)
class RequestOptions:
    operation: str
    method: str
    path: str
    query: dict[str, Any] | None = None
    json_body: Any | None = None
    headers: dict[str, str] | None = None
    allow_statuses: Iterable[int] | None = None


def _coerce_options(
    options: RequestOptions | None = None,
    *,
    operation: str | None = None,
    method: str | None = None,
    path: str | None = None,
    query: dict[str, Any] | None = None,
    json_body: Any | None = None,
    headers: dict[str, str] | None = None,
    allow_statuses: Iterable[int] | None = None,
) -> RequestOptions:
    if options is not None:
        return options

    if operation is None or method is None or path is None:
        raise TypeError("operation, method, and path are required when options are not provided")

    return RequestOptions(
        operation=operation,
        method=method,
        path=path,
        query=query,
        json_body=json_body,
        headers=headers,
        allow_statuses=allow_statuses,
    )


def encode_query(params: dict[str, Any] | None) -> str:
    if not params:
        return ""

    encoded: dict[str, str] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            encoded[key] = "true" if value else "false"
            continue
        encoded[key] = str(value)

    if not encoded:
        return ""
    return "?" + urlencode(encoded)


def parse_response_body(response: httpx.Response) -> Any:
    if not response.content:
        return None

    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type:
        return response.text

    try:
        return response.json()
    except JSONDecodeError:
        return response.text


def validate_status(response: httpx.Response, options: RequestOptions) -> None:
    # Some codex-manager endpoints intentionally return non-2xx control states
    # (for example 404/409/423) as part of normal lifecycle semantics.
    # Per-operation allow lists let callers opt into those responses directly.
    if options.allow_statuses is not None and response.status_code in set(options.allow_statuses):
        return

    if 200 <= response.status_code < 300:
        return

    details = RequestDetails(
        operation=options.operation,
        method=options.method,
        path=options.path,
        status_code=response.status_code,
        response_body=parse_response_body(response),
    )
    raise classify_api_error(details)


class SyncTransport:
    def __init__(self, client: httpx.Client, api_prefix: str) -> None:
        self._client = client
        self._api_prefix = api_prefix.rstrip("/")

    def request(
        self,
        options: RequestOptions | None = None,
        *,
        operation: str | None = None,
        method: str | None = None,
        path: str | None = None,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any:
        options = _coerce_options(
            options,
            operation=operation,
            method=method,
            path=path,
            query=query,
            json_body=json_body,
            headers=headers,
            allow_statuses=allow_statuses,
        )
        path = self._api_prefix + options.path
        if options.query:
            path += encode_query(options.query)

        try:
            response = self._client.request(
                options.method,
                path,
                json=options.json_body,
                headers=options.headers,
            )
        except httpx.TimeoutException as error:
            raise ClientTimeoutError(str(error)) from error
        except httpx.HTTPError as error:
            raise TransportError(str(error)) from error

        validate_status(response, options)
        return parse_response_body(response)


class AsyncTransport:
    def __init__(self, client: httpx.AsyncClient, api_prefix: str) -> None:
        self._client = client
        self._api_prefix = api_prefix.rstrip("/")

    async def request(
        self,
        options: RequestOptions | None = None,
        *,
        operation: str | None = None,
        method: str | None = None,
        path: str | None = None,
        query: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
        allow_statuses: Iterable[int] | None = None,
    ) -> Any:
        options = _coerce_options(
            options,
            operation=operation,
            method=method,
            path=path,
            query=query,
            json_body=json_body,
            headers=headers,
            allow_statuses=allow_statuses,
        )
        path = self._api_prefix + options.path
        if options.query:
            path += encode_query(options.query)

        try:
            response = await self._client.request(
                options.method,
                path,
                json=options.json_body,
                headers=options.headers,
            )
        except httpx.TimeoutException as error:
            raise ClientTimeoutError(str(error)) from error
        except httpx.HTTPError as error:
            raise TransportError(str(error)) from error

        validate_status(response, options)
        return parse_response_body(response)
