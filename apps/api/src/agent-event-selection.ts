import {
  classifyReconciledActionStatus,
  selectActionExecutionPlan,
  selectEnqueueWinner,
  type AgentEventActionResult,
  type AgentEventEmitResult,
  type AgentEventEnqueueResult
} from "@codex-manager/agent-runtime-sdk";

export function selectEnqueueResultFromAgentEvent(results: Array<AgentEventEmitResult>): AgentEventEnqueueResult | null {
  return selectEnqueueWinner(results);
}

export function selectFirstSuccessfulActionFromAgentEvent(results: Array<AgentEventEmitResult>): AgentEventActionResult | null {
  const plan = selectActionExecutionPlan(results);
  return plan.winner;
}

export function summarizeActionReconciliation(results: Array<AgentEventEmitResult>): {
  winner: AgentEventActionResult | null;
  reconciledCount: number;
  failedCount: number;
  reconciledStatuses: Array<AgentEventActionResult["status"]>;
} {
  const plan = selectActionExecutionPlan(results);
  return {
    winner: plan.winner,
    reconciledCount: plan.reconciled.length,
    failedCount: plan.failed.length,
    reconciledStatuses: plan.reconciled.map((entry) => entry.status)
  };
}

export function isReconciledActionStatus(status: AgentEventActionResult["status"]): boolean {
  return classifyReconciledActionStatus(status) === "reconciled";
}
