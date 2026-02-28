from __future__ import annotations

from codex_manager.models import AppServerSignal, StreamEvent


def test_stream_event_and_app_server_signal_parsing() -> None:
    event = StreamEvent.from_json(
        {
            "type": "app_server.item.started",
            "threadId": "thread_1",
            "payload": {
                "method": "item/started",
                "signalType": "notification",
                "receivedAt": "2026-01-01T00:00:00.000Z",
                "context": {"threadId": "thread_1", "turnId": "turn_1"},
                "params": {"foo": "bar"},
            },
        }
    )

    signal = AppServerSignal.from_stream_event(event)
    assert signal.event_type == "app_server.item.started"
    assert signal.method == "item/started"
    assert signal.signal_type == "notification"
    assert signal.context["turnId"] == "turn_1"
