"""Client plugin registration and lifecycle orchestration."""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING

from .protocols import AsyncClientPlugin, PluginLifecycle, SyncClientPlugin

if TYPE_CHECKING:
    from .client import AsyncCodexManager, CodexManager


class PluginRegistry:
    """Deterministic plugin registry shared by sync and async clients."""

    def __init__(self) -> None:
        self._lifecycles: list[PluginLifecycle] = []
        self._started = False

    def register_sync(self, client: CodexManager, plugins: Iterable[SyncClientPlugin]) -> None:
        for plugin in plugins:
            plugin.register(client)
            if isinstance(plugin, PluginLifecycle):
                self._lifecycles.append(plugin)
        self.start()

    def register_async(self, client: AsyncCodexManager, plugins: Iterable[AsyncClientPlugin]) -> None:
        for plugin in plugins:
            plugin.register(client)
            if isinstance(plugin, PluginLifecycle):
                self._lifecycles.append(plugin)
        self.start()

    def start(self) -> None:
        if self._started:
            return

        started: list[PluginLifecycle] = []
        try:
            for lifecycle in self._lifecycles:
                lifecycle.start()
                started.append(lifecycle)
        except Exception:
            for lifecycle in reversed(started):
                self._safe_stop(lifecycle)
            raise

        self._started = True

    def stop(self) -> None:
        if not self._started:
            return

        for lifecycle in reversed(self._lifecycles):
            self._safe_stop(lifecycle)
        self._started = False

    @staticmethod
    def _safe_stop(lifecycle: PluginLifecycle) -> None:
        try:
            lifecycle.stop()
        except Exception:
            return
