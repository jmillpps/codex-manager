/**
 * Shared runtime contracts for agent extension event modules under `agents/<agent>/events.(js|mjs|ts)`.
 *
 * This file is a thin alias layer over the canonical runtime SDK.
 */

export type {
  AgentRuntimeEvent as AgentEvent,
  AgentJobEnqueueInput,
  AgentJobEnqueueResult,
  AgentRuntimeTools as AgentEventTools,
  AgentRuntimeActionType,
  AgentRuntimeActionRequest,
  AgentRuntimeActionResult,
  AgentRuntimeActionPayloadByType,
  AgentEventHandler,
  AgentEventRegistry,
  AgentEventEmitResult,
  AgentEventEnqueueResult,
  AgentEventActionResult,
  AgentEventHandlerResult,
  AgentEventHandlerError
} from "@codex-manager/agent-runtime-sdk";
