"""Minimal team mesh example with remote skills and no codex-manager orchestrator jobs."""

from __future__ import annotations

import asyncio
import os
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

from codex_manager import (
    AppServerSignal,
    AsyncCodexManager,
    AsyncRemoteSkillSession,
    WaitTimeoutError,
)

MEMBER_ORDER = ("developer", "docs", "reviewer")
MEMBER_ROLES = {
    "developer": "implement features and hand off documentation/review work",
    "docs": "write concise operator-facing documentation from implementation artifacts",
    "reviewer": "validate implementation/docs quality and close the loop",
}
TEAM_PULL_WORK = "team_pull_work"
TEAM_QUEUE_WORK = "team_queue_work"
TEAM_PUBLISH_ARTIFACT = "team_publish_artifact"
TEAM_READ_BOARD = "team_read_board"
TEAM_MARK_DONE = "team_mark_done"


def _clean_text(value: str, *, field_name: str) -> str:
    text = value.strip()
    if not text:
        raise ValueError(f"{field_name} must be non-empty")
    return text


@dataclass(slots=True)
class TeamBoard:
    queues: dict[str, list[str]] = field(
        default_factory=lambda: {member: [] for member in MEMBER_ORDER}
    )
    artifacts: list[dict[str, str]] = field(default_factory=list)
    completed: set[str] = field(default_factory=set)

    def queue_work(self, owner: str, task: str, *, from_member: str) -> dict[str, Any]:
        if owner not in self.queues:
            raise ValueError(f"unknown member {owner!r}")
        if owner in self.completed:
            return {
                "queuedFor": owner,
                "queuedBy": from_member,
                "queueDepth": len(self.queues[owner]),
                "queued": False,
                "reason": "owner_completed",
            }
        task_text = _clean_text(task, field_name="task")
        self.queues[owner].append(task_text)
        return {
            "queuedFor": owner,
            "queuedBy": from_member,
            "queueDepth": len(self.queues[owner]),
            "task": task_text,
            "queued": True,
        }

    def pull_work(self, owner: str) -> dict[str, Any]:
        if owner not in self.queues:
            raise ValueError(f"unknown member {owner!r}")
        if owner in self.completed:
            return {"task": None, "queueDepth": 0, "reason": "member_completed"}
        queue = self.queues[owner]
        if not queue:
            return {"task": None, "queueDepth": 0}
        task = queue.pop(0)
        return {"task": task, "queueDepth": len(queue)}

    def publish_artifact(self, *, member: str, kind: str, summary: str) -> dict[str, Any]:
        artifact = {
            "member": member,
            "kind": _clean_text(kind, field_name="kind"),
            "summary": _clean_text(summary, field_name="summary"),
        }
        self.artifacts.append(artifact)
        return {"artifactCount": len(self.artifacts), "artifact": artifact}

    def mark_done(self, *, member: str, note: str = "") -> dict[str, Any]:
        self.completed.add(member)
        if member in self.queues:
            self.queues[member].clear()
        if note.strip():
            self.artifacts.append(
                {
                    "member": member,
                    "kind": "completion_note",
                    "summary": note.strip(),
                }
            )
        return {"completed": sorted(self.completed)}

    def snapshot(self, *, limit: int = 8) -> dict[str, Any]:
        queue_depths = {member: len(self.queues[member]) for member in MEMBER_ORDER}
        return {
            "queueDepths": queue_depths,
            "completed": sorted(self.completed),
            "recentArtifacts": self.artifacts[-max(1, limit) :],
        }

    def is_complete(self) -> bool:
        return "reviewer" in self.completed and all(
            len(self.queues[member]) == 0 for member in MEMBER_ORDER
        )


@dataclass(slots=True)
class TeamMember:
    name: str
    session_id: str
    skills: AsyncRemoteSkillSession


def _register_member_skills(
    skills: AsyncRemoteSkillSession, *, member_name: str, board: TeamBoard
) -> None:

    @skills.skill(
        name=TEAM_PULL_WORK,
        description="Claim the next queued task assigned to this team member.",
        input_schema={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    )
    async def pull_work() -> dict[str, Any]:
        return board.pull_work(member_name)

    @skills.skill(
        name=TEAM_QUEUE_WORK,
        description="Queue a follow-up task for another team member.",
        input_schema={
            "type": "object",
            "properties": {
                "owner": {"type": "string", "enum": list(MEMBER_ORDER)},
                "task": {"type": "string"},
            },
            "required": ["owner", "task"],
            "additionalProperties": False,
        },
    )
    async def queue_work(owner: str, task: str) -> dict[str, Any]:
        return board.queue_work(owner, task, from_member=member_name)

    @skills.skill(
        name=TEAM_PUBLISH_ARTIFACT,
        description="Publish implementation/docs/review output for the team board.",
        input_schema={
            "type": "object",
            "properties": {
                "kind": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["kind", "summary"],
            "additionalProperties": False,
        },
    )
    async def publish_artifact(kind: str, summary: str) -> dict[str, Any]:
        return board.publish_artifact(member=member_name, kind=kind, summary=summary)

    @skills.skill(
        name=TEAM_READ_BOARD,
        description="Read current queues, completion state, and recent artifacts.",
        input_schema={
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 25},
            },
            "additionalProperties": False,
        },
    )
    async def read_board(limit: int = 8) -> dict[str, Any]:
        return board.snapshot(limit=limit)

    @skills.skill(
        name=TEAM_MARK_DONE,
        description="Mark this member complete when their responsibilities are finished.",
        input_schema={
            "type": "object",
            "properties": {"note": {"type": "string"}},
            "additionalProperties": False,
        },
    )
    async def mark_done(note: str = "") -> dict[str, Any]:
        return board.mark_done(member=member_name, note=note)


def _resolve_signal_session_id(signal: AppServerSignal) -> str | None:
    session = signal.session if isinstance(signal.session, dict) else {}
    session_id = session.get("id")
    if isinstance(session_id, str) and session_id.strip():
        return session_id
    context = signal.context if isinstance(signal.context, dict) else {}
    thread_id = context.get("threadId")
    if isinstance(thread_id, str) and thread_id.strip():
        return thread_id
    return None


def _member_prompt(member_name: str) -> str:
    role = MEMBER_ROLES[member_name]
    if member_name == "developer":
        process = (
            f"1) Call {TEAM_PULL_WORK} once.\n"
            f"2) If task is null, call {TEAM_READ_BOARD} and reply with one short idle status.\n"
            f"3) If you have a task, call {TEAM_PUBLISH_ARTIFACT}.\n"
            f"4) Queue exactly one docs handoff and one reviewer handoff using {TEAM_QUEUE_WORK}.\n"
            f"5) Call {TEAM_MARK_DONE} and stop queueing.\n"
        )
    elif member_name == "docs":
        process = (
            f"1) Call {TEAM_PULL_WORK} once.\n"
            f"2) If task is null, call {TEAM_READ_BOARD} and reply with one short idle status.\n"
            f"3) If you have a task, call {TEAM_PUBLISH_ARTIFACT}.\n"
            f"4) Queue exactly one reviewer handoff using {TEAM_QUEUE_WORK}.\n"
            f"5) Call {TEAM_MARK_DONE} and stop queueing.\n"
        )
    else:
        process = (
            f"1) Call {TEAM_PULL_WORK} once.\n"
            f"2) If task is null, call {TEAM_READ_BOARD}.\n"
            f"3) If you have a task, call {TEAM_PUBLISH_ARTIFACT}.\n"
            f"4) Call {TEAM_READ_BOARD}; if the board is coherent, call {TEAM_MARK_DONE}.\n"
            "5) Do not queue follow-up work unless you detect a blocking issue.\n"
        )

    return (
        f"You are the {member_name}.\n"
        f"Role: {role}.\n\n"
        "Runtime constraints:\n"
        "- This is a team-coordination simulation.\n"
        "- Do not run shell commands.\n"
        "- Do not edit files.\n"
        "- Use only the team_* dynamic tools.\n\n"
        "Process for this turn:\n"
        f"{process}"
        "Always perform at least one team_* tool call before your final reply."
    )


def _assistant_reply_for_turn(detail: Any, turn_id: str) -> str | None:
    if not isinstance(detail, dict):
        return None
    transcript = detail.get("transcript")
    if not isinstance(transcript, list):
        return None
    for entry in reversed(transcript):
        if not isinstance(entry, dict):
            continue
        if entry.get("turnId") != turn_id:
            continue
        if entry.get("role") != "assistant":
            continue
        if entry.get("status") != "complete":
            continue
        content = entry.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
    return None


def _turn_status(detail: Any, turn_id: str) -> str | None:
    if not isinstance(detail, dict):
        return None
    thread = detail.get("thread")
    if not isinstance(thread, dict):
        return None
    turns = thread.get("turns")
    if not isinstance(turns, list):
        return None
    for turn in turns:
        if not isinstance(turn, dict):
            continue
        if turn.get("id") != turn_id:
            continue
        status = turn.get("status")
        if isinstance(status, str) and status.strip():
            return status.strip()
        return None
    return None


def _turn_terminal_or_unknown(detail: Any, turn_id: str) -> bool:
    status = _turn_status(detail, turn_id)
    if status is None:
        return _assistant_reply_for_turn(detail, turn_id) is not None
    return status.lower() in {
        "completed",
        "complete",
        "failed",
        "error",
        "interrupted",
        "canceled",
        "cancelled",
    }


async def _poll_turn_with_pending(*, cm: AsyncCodexManager, member: TeamMember) -> Any:
    # Polling fallback keeps tool-call dispatch reliable even if websocket events are delayed.
    dispatches = await member.skills.drain_pending_calls()
    for dispatched in dispatches:
        print(f"[tool-call] {member.name}: {dispatched.tool}")
    return await cm.sessions.get(session_id=member.session_id)


async def run_team_mesh(*, rounds: int = 9) -> None:
    manager_factory = (
        AsyncCodexManager.from_env
        if os.getenv("CODEX_MANAGER_API_BASE")
        else (lambda: AsyncCodexManager.from_profile("local"))
    )
    async with manager_factory() as cm:
        board = TeamBoard()
        members_by_name: dict[str, TeamMember] = {}
        members_by_session: dict[str, TeamMember] = {}

        for member_name in MEMBER_ORDER:
            created, skills = await cm.remote_skills.create_session(
                cwd=".",
                approval_policy="never",
                filesystem_sandbox="workspace-write",
                register=lambda draft, member_name=member_name: _register_member_skills(
                    draft,
                    member_name=member_name,
                    board=board,
                ),
            )
            session_id = created["session"]["sessionId"]
            await cm.sessions.rename(session_id=session_id, title=f"team-{member_name}")
            member = TeamMember(name=member_name, session_id=session_id, skills=skills)
            members_by_name[member_name] = member
            members_by_session[session_id] = member

        @cm.on_app_server_request("item.tool.call")
        async def on_tool_call(signal: AppServerSignal, _ctx: Any) -> None:
            session_id = _resolve_signal_session_id(signal)
            if session_id is None:
                return
            member = members_by_session.get(session_id)
            if member is None:
                return
            dispatched = await member.skills.respond_to_signal(signal)
            if dispatched is not None:
                print(f"[tool-call] {member.name}: {dispatched.tool}")

        # Seed one initial development task. All other work is handed off by the team.
        board.queue_work(
            "developer",
            (
                "Draft a concise implementation plan for a repository-summary workflow. "
                "Do not run commands or edit files. Then queue one docs handoff for docs "
                "and one validation handoff for reviewer."
            ),
            from_member="system",
        )

        stop_event = asyncio.Event()
        stream_task = asyncio.create_task(cm.stream.run_forever(stop_event=stop_event))

        try:
            for round_number in range(1, rounds + 1):
                if board.is_complete():
                    break
                progressed = False

                for member_name in MEMBER_ORDER:
                    if not board.queues[member_name]:
                        continue
                    progressed = True
                    member = members_by_name[member_name]
                    accepted = await member.skills.send(
                        _member_prompt(member_name), inject_skills=False
                    )
                    turn_id = accepted.get("turnId")
                    if not isinstance(turn_id, str) or not turn_id.strip():
                        continue
                    try:

                        async def poll_turn(member: TeamMember = member) -> Any:
                            return await _poll_turn_with_pending(cm=cm, member=member)

                        def turn_complete(payload: Any, turn_id: str = turn_id) -> bool:
                            return _turn_terminal_or_unknown(payload, turn_id)

                        detail = await cm.wait.until(
                            poll_turn,
                            predicate=turn_complete,
                            timeout_seconds=120,
                            interval_seconds=1.0,
                            description=f"assistant reply for {member_name} turn {turn_id}",
                        )
                    except WaitTimeoutError:
                        print(
                            f"[round {round_number}] {member_name}: timeout waiting for turn "
                            f"{turn_id}"
                        )
                        pending_approvals = await cm.sessions.approvals(
                            session_id=member.session_id
                        )
                        approval_rows = (
                            pending_approvals.get("data")
                            if isinstance(pending_approvals, dict)
                            else None
                        )
                        if isinstance(approval_rows, list) and approval_rows:
                            print(
                                f"[round {round_number}] {member_name}: pending approvals="
                                f"{len(approval_rows)}"
                            )
                        pending_calls = await cm.sessions.tool_calls(session_id=member.session_id)
                        call_rows = (
                            pending_calls.get("data") if isinstance(pending_calls, dict) else None
                        )
                        if isinstance(call_rows, list) and call_rows:
                            print(
                                f"[round {round_number}] {member_name}: pending tool calls="
                                f"{len(call_rows)}"
                            )
                        continue
                    assistant_reply = _assistant_reply_for_turn(detail, turn_id) or ""
                    first_line = (
                        assistant_reply.splitlines()[0]
                        if assistant_reply
                        else "(no assistant reply)"
                    )
                    print(f"[round {round_number}] {member_name}: {first_line}")

                if not progressed:
                    break
        finally:
            stop_event.set()
            stream_task.cancel()
            with suppress(asyncio.CancelledError):
                await stream_task

        print("Final board snapshot:")
        print(board.snapshot(limit=12))


if __name__ == "__main__":
    asyncio.run(run_team_mesh())
