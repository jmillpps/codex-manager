from __future__ import annotations

from typing import Any

from codex_manager.api import SessionSettingsScope


class FakeSessions:
    def __init__(self) -> None:
        self.store: dict[str, dict[str, Any]] = {}

    def settings_get(
        self, *, session_id: str, scope: str = "session", key: str | None = None
    ) -> dict[str, Any]:
        settings = self.store.setdefault(session_id, {})
        if key is None:
            return {"status": "ok", "settings": settings}
        return {
            "status": "ok",
            "key": key,
            "found": key in settings,
            "value": settings.get(key),
        }

    def settings_set(
        self,
        *,
        session_id: str,
        scope: str = "session",
        settings: dict[str, Any] | None = None,
        mode: str | None = "merge",
        key: str | None = None,
        value: Any | None = None,
        actor: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        session_settings = self.store.setdefault(session_id, {})
        if settings is not None:
            if mode == "replace":
                session_settings.clear()
            session_settings.update(settings)
            return {"status": "ok", "settings": session_settings}
        session_settings[key or ""] = value
        return {"status": "ok", "settings": session_settings}

    def settings_unset(
        self,
        *,
        session_id: str,
        key: str,
        scope: str = "session",
        actor: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        session_settings = self.store.setdefault(session_id, {})
        removed = session_settings.pop(key, None) is not None
        return {"status": "ok", "removed": removed, "settings": session_settings}


def test_namespace_merge_and_get() -> None:
    fake = FakeSessions()
    scope = SessionSettingsScope(sessions=fake, session_id="s1")

    ns = scope.namespace("supervisor.fileChange")
    ns.merge({"diffExplainability": True})
    assert ns.get() == {"diffExplainability": True}

    root = scope.get(key="supervisor")
    assert root["value"]["fileChange"]["diffExplainability"] is True
