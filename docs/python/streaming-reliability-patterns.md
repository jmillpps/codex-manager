# Python Streaming Reliability Patterns

## Purpose

Operational guidance for resilient websocket listeners in the Python SDK.

Use with [`streaming-and-handlers.md`](./streaming-and-handlers.md) when building long-running automation listeners.

## Built-in Reliability Behaviors

The async stream client includes:

- reconnect loop with bounded exponential backoff
- periodic ping messages
- receive timeout loop that keeps heartbeat active
- malformed-message tolerance (logs and continues)

The sync stream wrapper delegates to async behavior via `asyncio.run(...)`.

## Recommended Listener Structure

Keep one listener process per concern with explicit stop control.

Async pattern:

```python
import asyncio
from codex_manager import AsyncCodexManager

async def run_listener(session_id: str) -> None:
    stop = asyncio.Event()

    async with AsyncCodexManager.from_profile("local") as cm:
        @cm.on_app_server("item.started")
        async def on_turn(signal, _ctx):
            if signal.context.get("threadId") != session_id:
                return
            print("turn started", signal.context.get("turnId"))

        await cm.stream.run_forever(thread_id=session_id, stop_event=stop)
```

## Reconnect and Idempotency

Reconnect can replay state windows from server or trigger repeated downstream checks.

Handler design rules:

- make external side effects idempotent
- key side effects by stable ids (`threadId`, `turnId`, `requestId`)
- ignore already-processed request ids where possible

## Backpressure and Throughput

Avoid heavy compute or slow blocking I/O inside handlers.

Preferred patterns:

- enqueue internal work to task queue
- quickly acknowledge and return
- use bounded worker pools for expensive tasks

This prevents head-of-line blocking in your stream loop.

## Observability Signals

Track at minimum:

- reconnect count
- handler exception count
- per-event processing latency
- pending background work depth

`StreamContext.reconnect_count` is available in handlers for diagnostics.

## Failure Classification

Typical failure classes:

- transport/connectivity instability
- malformed event payload assumptions in handler logic
- downstream API submission failures after event receipt

Treat stream connectivity and post-event work as separate reliability domains.

## Safe Shutdown

Async clients should pass `stop_event` and set it during shutdown sequences.

Also ensure:

- background tasks are awaited or canceled cleanly
- client context manager exits so HTTP and websocket resources close

## Polling Fallback Strategy

When websocket delivery is delayed or absent for critical workflows:

- keep stream listener active
- add periodic polling fallback for critical state (`wait` helpers, pending tool-call lists)
- reconcile by stable ids to avoid duplicate side effects

This hybrid model is especially useful for remote-skill response guarantees.

## Related docs

- Streaming and handlers overview: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Event routing details: [`streaming-event-routing-reference.md`](./streaming-event-routing-reference.md)
- Remote-skill pending-call fallback: [`remote-skills-dispatch-and-reliability.md`](./remote-skills-dispatch-and-reliability.md)
