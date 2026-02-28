"""Configuration helpers for codex-manager client."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "http://127.0.0.1:3001"
DEFAULT_API_PREFIX = "/api"
DEFAULT_TIMEOUT_SECONDS = 30.0


@dataclass(slots=True)
class ClientConfig:
    base_url: str = DEFAULT_BASE_URL
    api_prefix: str = DEFAULT_API_PREFIX
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "ClientConfig":
        base_url = os.getenv("CODEX_MANAGER_API_BASE", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
        api_prefix = normalize_prefix(os.getenv("CODEX_MANAGER_API_PREFIX", DEFAULT_API_PREFIX))
        timeout_ms = _parse_positive_int(os.getenv("CODEX_MANAGER_TIMEOUT_MS"))
        timeout_seconds = (timeout_ms / 1000.0) if timeout_ms else DEFAULT_TIMEOUT_SECONDS

        headers: dict[str, str] = {}
        bearer = _trim_or_none(os.getenv("CODEX_MANAGER_BEARER_TOKEN"))
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"

        rbac_token = _trim_or_none(os.getenv("CODEX_MANAGER_RBAC_TOKEN"))
        if rbac_token:
            headers["x-codex-rbac-token"] = rbac_token

        role = _trim_or_none(os.getenv("CODEX_MANAGER_RBAC_ROLE"))
        if role:
            headers["x-codex-rbac-role"] = role

        actor = _trim_or_none(os.getenv("CODEX_MANAGER_RBAC_ACTOR"))
        if actor:
            headers["x-codex-rbac-actor"] = actor

        return cls(base_url=base_url, api_prefix=api_prefix, timeout_seconds=timeout_seconds, headers=headers)

    @classmethod
    def from_profile(
        cls,
        profile: str | None = None,
        *,
        config_path: str | Path | None = None,
    ) -> "ClientConfig":
        payload = load_cli_config(config_path=config_path)
        profiles = payload.get("profiles") if isinstance(payload, dict) else None
        current_profile = payload.get("currentProfile") if isinstance(payload, dict) else None

        selected_name = (profile or current_profile or "local").strip() or "local"
        profile_entry: dict[str, Any] = {}
        if isinstance(profiles, dict) and isinstance(profiles.get(selected_name), dict):
            profile_entry = dict(profiles[selected_name])
        elif isinstance(profiles, dict) and isinstance(profiles.get("local"), dict):
            profile_entry = dict(profiles["local"])

        base_url = _trim_or_default(profile_entry.get("baseUrl"), DEFAULT_BASE_URL)
        api_prefix = normalize_prefix(_trim_or_default(profile_entry.get("apiPrefix"), DEFAULT_API_PREFIX))
        timeout_ms = _parse_positive_int(profile_entry.get("timeoutMs"))
        timeout_seconds = (timeout_ms / 1000.0) if timeout_ms else DEFAULT_TIMEOUT_SECONDS

        headers: dict[str, str] = {}
        raw_headers = profile_entry.get("headers")
        if isinstance(raw_headers, dict):
            for key, value in raw_headers.items():
                if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip():
                    headers[key] = value

        auth = profile_entry.get("auth")
        if isinstance(auth, dict):
            bearer = _trim_or_none(auth.get("bearer"))
            if bearer:
                headers["Authorization"] = f"Bearer {bearer}"

            rbac_token = _trim_or_none(auth.get("rbacToken"))
            if rbac_token:
                headers["x-codex-rbac-token"] = rbac_token

            role = _trim_or_none(auth.get("role"))
            if role:
                headers["x-codex-rbac-role"] = role

            actor = _trim_or_none(auth.get("actor"))
            if actor:
                headers["x-codex-rbac-actor"] = actor

        return cls(base_url=base_url, api_prefix=api_prefix, timeout_seconds=timeout_seconds, headers=headers)


def normalize_prefix(value: str | None) -> str:
    trimmed = (value or "").strip()
    if not trimmed:
        return DEFAULT_API_PREFIX
    return trimmed if trimmed.startswith("/") else f"/{trimmed}"


def default_cli_config_path() -> Path:
    xdg = os.getenv("XDG_CONFIG_HOME")
    root = Path(xdg) if xdg else Path.home() / ".config"
    return root / "codex-manager" / "cli" / "config.json"


def load_cli_config(*, config_path: str | Path | None = None) -> dict[str, Any]:
    path = Path(config_path) if config_path else default_cli_config_path()
    if not path.exists():
        return {"currentProfile": "local", "profiles": {}}

    try:
        with path.open("r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"currentProfile": "local", "profiles": {}}

    if not isinstance(parsed, dict):
        return {"currentProfile": "local", "profiles": {}}
    return parsed


def _trim_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed if trimmed else None


def _trim_or_default(value: Any, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    trimmed = value.strip()
    return trimmed if trimmed else fallback


def _parse_positive_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        try:
            parsed = int(value)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None
