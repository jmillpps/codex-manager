# Python API Surface Workflow Snippets

## Purpose

Workflow-oriented snippets for common API-surface usage patterns.

Use with [`api-surface.md`](./api-surface.md).

## Resolve pending approvals

```python
pending = cm.session(session_id).approvals.list()
for approval in pending.get("data", []):
    cm.approvals.decide(approval_id=approval["approvalId"], decision="accept", scope="turn")
```

## Resolve pending tool-input requests

```python
requests = cm.session(session_id).tool_input.list()
for req in requests.get("data", []):
    cm.tool_input.decide(request_id=req["requestId"], decision="decline", response={"note": "manual review"})
```

## Resolve dynamic tool-call requests

```python
pending = cm.session(session_id).tool_calls.list()
for req in pending.get("data", []):
    cm.tool_calls.respond(request_id=req["requestId"], text="Handled", success=True)
```

## Use wait helpers

```python
reply = cm.wait.send_message_and_wait_reply(session_id=session_id, text="Explain this repo")
print(reply.assistant_reply)
```

```python
status = cm.wait.turn_status(
    session_id=session_id,
    turn_id=turn_id,
    expected={"completed", "failed", "error"},
    timeout_seconds=60,
    interval_seconds=0.25,
)
print("terminal status:", status)
```

## Handle turn/suggestion status outcomes explicitly

```python
accepted = cm.sessions.send_message(session_id=session_id, text="Summarize this repo in 5 bullets.")
if accepted.get("status") == "accepted":
    print("turn:", accepted["turnId"])

interrupt = cm.sessions.interrupt(session_id=session_id)
if interrupt.get("status") == "no_active_turn":
    print("no active turn to interrupt")

suggest = cm.sessions.suggest_request(session_id=session_id)
if suggest.get("status") in {"queued", "ok", "fallback", "no_context"}:
    print("suggest status:", suggest["status"])
```

System-owned worker sessions return `403` on these wrappers.

## Clean up an ephemeral session

```python
chat = cm.session(session_id)
chat.delete()
```

## Related docs

- API surface index: [`api-surface.md`](./api-surface.md)
- Streaming/event handlers: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Typed model facade: [`typed-models.md`](./typed-models.md)
