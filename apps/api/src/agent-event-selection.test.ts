import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEventEmitResult } from "@codex-manager/agent-runtime-sdk";
import {
  isReconciledActionStatus,
  selectEnqueueResultFromAgentEvent,
  selectFirstSuccessfulActionFromAgentEvent,
  summarizeActionReconciliation
} from "./agent-event-selection.js";

test("selectEnqueueResultFromAgentEvent prefers newly enqueued jobs", () => {
  const results: Array<AgentEventEmitResult> = [
    {
      kind: "enqueue_result",
      moduleName: "a",
      status: "already_queued",
      job: {
        id: "job-existing",
        type: "suggest_request",
        projectId: "p1",
        state: "queued"
      }
    },
    {
      kind: "enqueue_result",
      moduleName: "b",
      status: "enqueued",
      job: {
        id: "job-new",
        type: "suggest_request",
        projectId: "p1",
        state: "queued"
      }
    }
  ];

  const winner = selectEnqueueResultFromAgentEvent(results);
  assert.equal(winner?.job.id, "job-new");
  assert.equal(winner?.status, "enqueued");
});

test("selectEnqueueResultFromAgentEvent falls back to already_queued when no new enqueue exists", () => {
  const results: Array<AgentEventEmitResult> = [
    {
      kind: "enqueue_result",
      moduleName: "a",
      status: "already_queued",
      job: {
        id: "job-existing",
        type: "suggest_request",
        projectId: "p1",
        state: "running"
      }
    }
  ];

  const winner = selectEnqueueResultFromAgentEvent(results);
  assert.equal(winner?.job.id, "job-existing");
  assert.equal(winner?.status, "already_queued");
});

test("summarizeActionReconciliation identifies winner and reconciled statuses", () => {
  const results: Array<AgentEventEmitResult> = [
    {
      kind: "action_result",
      moduleName: "m1",
      actionType: "approval.accept",
      status: "performed"
    },
    {
      kind: "action_result",
      moduleName: "m2",
      actionType: "approval.accept",
      status: "already_resolved"
    },
    {
      kind: "action_result",
      moduleName: "m3",
      actionType: "approval.accept",
      status: "failed"
    }
  ];

  const winner = selectFirstSuccessfulActionFromAgentEvent(results);
  assert.equal(winner?.moduleName, "m1");

  const summary = summarizeActionReconciliation(results);
  assert.equal(summary.winner?.moduleName, "m1");
  assert.equal(summary.reconciledCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.deepEqual(summary.reconciledStatuses, ["already_resolved"]);
  assert.equal(isReconciledActionStatus("already_resolved"), true);
  assert.equal(isReconciledActionStatus("failed"), false);
});
