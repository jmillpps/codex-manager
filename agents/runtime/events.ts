/**
 * Shared runtime contracts for agent extension event modules under `agents/*/events.(ts|js)`.
 *
 * These types are for extension authors. API loads modules dynamically at runtime.
 */

export type AgentEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type AgentJobEnqueueInput = {
  type: string;
  projectId: string;
  sourceSessionId?: string | null;
  payload: Record<string, unknown>;
};

export type AgentJobEnqueueResult = {
  status: "enqueued" | "already_queued";
  job: {
    id: string;
    type: string;
    projectId: string;
    state: "queued" | "running" | "completed" | "failed" | "canceled";
  };
};

export type AgentEventTools = {
  enqueueJob: (input: AgentJobEnqueueInput) => Promise<AgentJobEnqueueResult>;
  logger: {
    debug: (input: Record<string, unknown>, message?: string) => void;
    info: (input: Record<string, unknown>, message?: string) => void;
    warn: (input: Record<string, unknown>, message?: string) => void;
    error: (input: Record<string, unknown>, message?: string) => void;
  };
};

export type AgentEventHandler = (event: AgentEvent, tools: AgentEventTools) => Promise<unknown> | unknown;

export type AgentEventRegistry = {
  on: (eventType: string, handler: AgentEventHandler) => void;
};
