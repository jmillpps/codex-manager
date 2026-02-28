from __future__ import annotations

from dataclasses import dataclass

import pytest

from codex_manager import AsyncCodexManager, CodexManager


@dataclass
class _NoopExecutor:
    def request(self, **_kwargs):
        return {"ok": True}


@dataclass
class _AsyncNoopExecutor:
    async def request(self, **_kwargs):
        return {"ok": True}


def test_sync_plugins_register_and_lifecycle_order() -> None:
    events: list[str] = []

    class Plugin:
        def __init__(self, name: str) -> None:
            self.name = name

        def register(self, _client: CodexManager) -> None:
            events.append(f"register:{self.name}")

        def start(self) -> None:
            events.append(f"start:{self.name}")

        def stop(self) -> None:
            events.append(f"stop:{self.name}")

    first = Plugin("first")
    second = Plugin("second")

    client = CodexManager(request_executor=_NoopExecutor(), plugins=[first, second])
    try:
        assert events == ["register:first", "register:second", "start:first", "start:second"]
    finally:
        client.close()

    assert events == [
        "register:first",
        "register:second",
        "start:first",
        "start:second",
        "stop:second",
        "stop:first",
    ]


@pytest.mark.asyncio
async def test_async_plugins_register_and_lifecycle_order() -> None:
    events: list[str] = []

    class Plugin:
        def __init__(self, name: str) -> None:
            self.name = name

        def register(self, _client: AsyncCodexManager) -> None:
            events.append(f"register:{self.name}")

        def start(self) -> None:
            events.append(f"start:{self.name}")

        def stop(self) -> None:
            events.append(f"stop:{self.name}")

    first = Plugin("first")
    second = Plugin("second")

    client = AsyncCodexManager(request_executor=_AsyncNoopExecutor(), plugins=[first, second])
    try:
        assert events == ["register:first", "register:second", "start:first", "start:second"]
    finally:
        await client.close()

    assert events == [
        "register:first",
        "register:second",
        "start:first",
        "start:second",
        "stop:second",
        "stop:first",
    ]


def test_plugin_registration_failure_fails_fast() -> None:
    class BrokenPlugin:
        name = "broken"

        def register(self, _client: CodexManager) -> None:
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        CodexManager(request_executor=_NoopExecutor(), plugins=[BrokenPlugin()])
