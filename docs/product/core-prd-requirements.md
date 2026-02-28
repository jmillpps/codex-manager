# Product PRD Deep Dive: Requirements

## Purpose

This is the detailed requirements layer for the core Codex Manager product PRD.

Use this with `docs/prd.md` when you need explicit requirement statements for implementation, review, or release-gate traceability.

## Product Scope Baseline

Codex Manager is a local-first control plane around `codex app-server`.

Required product outcomes:

- reliable chat/session lifecycle operations
- stream-correct transcript UX
- approval/tool-input visibility and actionability
- operator-grade control surfaces (web/CLI/API/Python)
- extensible automation through event-driven extension runtime and queue execution

## Functional Requirements

## Session lifecycle

- create new chats quickly and navigate immediately.
- list/read existing chats and projects with stable identity.
- resume chats after restart with correct metadata and transcript reconstruction.
- support rename/archive/unarchive/delete lifecycle actions.
- support project assignment/movement semantics for chats.

## Turn lifecycle and transcript behavior

- send user requests and receive progressive assistant responses.
- stream must remain ordered by turn/item semantics.
- completion must finalize state deterministically.
- interruption/cancel should stop active turn behavior quickly and clearly.

## Approval and tool-input workflows

- render pending approvals/tool-input prompts in-context.
- submit decisions exactly once per request id.
- reflect resolution state consistently across websocket + REST reconciliation.

## Tool-call visibility and dynamic tooling

- expose runtime tool activity without overwhelming core chat UX.
- support dynamic tool-call request/response routing via API surfaces.
- preserve operator visibility for failures and delayed resolution windows.

## Controls, settings, and governance

- support per-session control tuple (`model`, approval policy, network, sandbox).
- support generic per-session settings store for shared UI/CLI/extension policy state.
- support lock-aware default scope behavior where harness controls defaults.

## Extension/runtime automation

- support deterministic extension event dispatch and queue enqueue behavior.
- support extension lifecycle inventory/reload with trust/RBAC governance.
- keep workflow semantics in extension code, not API core hard-coding.

## Technical Requirements

## Protocol fidelity

- Codex runtime semantics remain authoritative.
- API must preserve event ordering and lifecycle state transitions.
- runtime requests/responses must map cleanly into REST/websocket contracts.

## Durability and recovery

- persist operational metadata under `.data/`.
- reconstruct chat state reliably across restart windows.
- keep queue state explicit and recoverable.

## Transport behavior

- websocket stream drives live UX and automation loops.
- read-path reconciliation handles missed stream windows.
- error paths must return structured status/code payloads.

## Security posture

- local-first by default (loopback host binding).
- secrets remain backend/runtime-side.
- extension lifecycle mutation uses explicit RBAC/trust controls.

## UX Requirements

## Chat-first layout and readability

- transcript prioritizes human conversation readability.
- thought/tool/approval content must be inspectable without dominating the main response.

## State clarity

- users can clearly infer sending/streaming/completed/failed states.
- pending decision states are distinguishable from resolved history.

## Recovery UX

- disconnected/recovery windows are explicit.
- user should have deterministic recovery action paths (`reconnect`, `refresh`, `retry`).

## Requirement Traceability Expectations

Every requirement should map to:

- API/websocket contract behavior
- UI/CLI/Python surfaces where applicable
- validation/test evidence
- documentation updates in the same change when behavior changes

## Related docs

- PRD foundation: [`../prd.md`](../prd.md)
- Delivery/risk/milestones deep dive: [`core-prd-delivery-and-risk.md`](./core-prd-delivery-and-risk.md)
- Agent platform requirements: [`agent-platform-requirements.md`](./agent-platform-requirements.md)
- Architecture invariants: [`../architecture.md`](../architecture.md)
- Implementation coverage snapshot: [`../implementation-status.md`](../implementation-status.md)
