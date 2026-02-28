# Python Deep Dive: API Surface Workflow Snippets

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

## Related docs

- API surface index: [`api-surface.md`](./api-surface.md)
- Streaming/event handlers: [`streaming-and-handlers.md`](./streaming-and-handlers.md)
- Typed model facade: [`typed-models.md`](./typed-models.md)
