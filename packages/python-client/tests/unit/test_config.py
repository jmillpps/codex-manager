from __future__ import annotations

import json
from pathlib import Path

from codex_manager.config import ClientConfig


def test_from_profile_loads_cli_shape(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "currentProfile": "local",
                "profiles": {
                    "local": {
                        "baseUrl": "http://127.0.0.1:3001",
                        "apiPrefix": "/api",
                        "timeoutMs": 45000,
                        "headers": {"x-test": "ok"},
                        "auth": {
                            "bearer": "abc",
                            "rbacToken": "rbac",
                            "role": "admin",
                            "actor": "tester",
                        },
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    cfg = ClientConfig.from_profile("local", config_path=config_path)
    assert cfg.base_url == "http://127.0.0.1:3001"
    assert cfg.api_prefix == "/api"
    assert cfg.timeout_seconds == 45.0
    assert cfg.headers["Authorization"] == "Bearer abc"
    assert cfg.headers["x-codex-rbac-token"] == "rbac"
    assert cfg.headers["x-codex-rbac-role"] == "admin"
    assert cfg.headers["x-codex-rbac-actor"] == "tester"
