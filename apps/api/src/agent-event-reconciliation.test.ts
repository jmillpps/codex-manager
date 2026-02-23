import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReconciledActionStatus,
  selectActionExecutionPlan,
  selectFirstSuccessfulAction,
  type AgentEventEmitResult
} from "@codex-manager/agent-runtime-sdk";

test("first successful action wins deterministically", () => {
  const results: Array<AgentEventEmitResult> = [
    {
      kind: "action_result",
      moduleName: "agent-a",
      actionType: "approval.accept",
      status: "performed"
    },
    {
      kind: "action_result",
      moduleName: "agent-b",
      actionType: "approval.accept",
      status: "performed"
    },
    {
      kind: "action_result",
      moduleName: "agent-c",
      actionType: "approval.accept",
      status: "already_resolved"
    }
  ];

  const winner = selectFirstSuccessfulAction(results);
  assert.equal(winner?.moduleName, "agent-a");

  const plan = selectActionExecutionPlan(results);
  assert.equal(plan.winner?.moduleName, "agent-a");
  assert.equal(plan.reconciled.length, 2);
  assert.equal(plan.failed.length, 0);
  assert.deepEqual(
    plan.reconciled.map((entry) => entry.status),
    ["performed", "already_resolved"]
  );
});

test("user-first reconciliation statuses are non-fatal", () => {
  assert.equal(classifyReconciledActionStatus("already_resolved"), "reconciled");
  assert.equal(classifyReconciledActionStatus("not_eligible"), "reconciled");
  assert.equal(classifyReconciledActionStatus("conflict"), "reconciled");
  assert.equal(classifyReconciledActionStatus("failed"), "failed");
});
