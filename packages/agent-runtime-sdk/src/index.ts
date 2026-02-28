export const AGENT_RUNTIME_CORE_API_VERSION = 1;

export type RuntimeProfileId = string;

export type AgentRuntimeProfile = {
  runtimeProfileId: RuntimeProfileId;
  runtimeProfileVersion: string;
  coreApiVersion: number;
};

export type AgentRuntimeProfileCompatibility = {
  name: RuntimeProfileId;
  version?: string;
  versionRange?: string;
};

export type AgentRuntimeCompatibility = {
  coreApiVersion?: number;
  coreApiVersionRange?: string;
  profiles: Array<AgentRuntimeProfileCompatibility>;
};

export type AgentRuntimeEvent<TType extends string = string, TPayload = Record<string, unknown>> = {
  type: TType;
  payload: TPayload;
  emittedAt?: string;
  correlationId?: string;
};

export type AgentJobState = "queued" | "running" | "completed" | "failed" | "canceled";

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
    state: AgentJobState;
  };
};

export type AgentRuntimeLogger = {
  debug: (input: Record<string, unknown>, message?: string) => void;
  info: (input: Record<string, unknown>, message?: string) => void;
  warn: (input: Record<string, unknown>, message?: string) => void;
  error: (input: Record<string, unknown>, message?: string) => void;
};

export type AgentRuntimeActionType =
  | "transcript.upsert"
  | "approval.decide"
  | "turn.steer.create"
  | "queue.enqueue"
  | (string & {});

export type AgentRuntimeActionStatus =
  | "performed"
  | "already_resolved"
  | "not_eligible"
  | "conflict"
  | "forbidden"
  | "invalid"
  | "failed";

export type AgentRuntimeTranscriptUpsertActionPayload = {
  sessionId: string;
  entry: {
    messageId: string;
    turnId: string;
    role: "user" | "assistant" | "system";
    type: string;
    content: string;
    details?: string;
    status: "streaming" | "complete" | "canceled" | "error";
    startedAt?: number;
    completedAt?: number;
  };
};

export type AgentRuntimeApprovalDecisionActionPayload = {
  approvalId: string;
  decision: "accept" | "decline";
  scope?: "turn" | "session";
};

export type AgentRuntimeTurnSteerActionPayload = {
  sessionId: string;
  turnId: string;
  input: string;
};

export type AgentRuntimeActionPayloadByType = {
  "transcript.upsert": AgentRuntimeTranscriptUpsertActionPayload;
  "approval.decide": AgentRuntimeApprovalDecisionActionPayload;
  "turn.steer.create": AgentRuntimeTurnSteerActionPayload;
  "queue.enqueue": AgentJobEnqueueInput;
};

export type AgentRuntimeActionPayload<T extends AgentRuntimeActionType> = T extends keyof AgentRuntimeActionPayloadByType
  ? AgentRuntimeActionPayloadByType[T]
  : Record<string, unknown>;

export type AgentRuntimeActionRequest<T extends AgentRuntimeActionType = AgentRuntimeActionType> = {
  kind: "action_request";
  actionType: T;
  payload: AgentRuntimeActionPayload<T>;
  requestId?: string;
  idempotencyKey?: string;
};

export type AgentRuntimeActionResult<T extends AgentRuntimeActionType = AgentRuntimeActionType> = {
  actionType: T;
  status: AgentRuntimeActionStatus;
  requestId?: string;
  idempotencyKey?: string;
  details?: Record<string, unknown>;
};

export type AgentRuntimeActionExecutor = (
  input: AgentRuntimeActionRequest
) => Promise<AgentRuntimeActionResult>;

export type AgentRuntimeTools = {
  enqueueJob: (input: AgentJobEnqueueInput) => Promise<AgentJobEnqueueResult>;
  logger: AgentRuntimeLogger;
  getSessionSettings?: (sessionId: string) => Promise<Record<string, unknown>>;
  getSessionSetting?: (sessionId: string, key: string) => Promise<unknown>;
};

export type AgentEventEnqueueResult = {
  kind: "enqueue_result";
  moduleName: string;
  status: "enqueued" | "already_queued";
  job: {
    id: string;
    type: string;
    projectId: string;
    state: AgentJobState;
  };
};

export type AgentEventActionResult = {
  kind: "action_result";
  moduleName: string;
  actionType: AgentRuntimeActionType;
  status: AgentRuntimeActionStatus;
  requestId?: string;
  idempotencyKey?: string;
  details?: Record<string, unknown>;
};

export type AgentEventHandlerResult = {
  kind: "handler_result";
  moduleName: string;
  details?: Record<string, unknown>;
};

export type AgentEventHandlerError = {
  kind: "handler_error";
  moduleName: string;
  eventType: string;
  error: string;
};

export type AgentEventEmitResult =
  | AgentEventEnqueueResult
  | AgentEventActionResult
  | AgentEventHandlerResult
  | AgentEventHandlerError;

export type AgentEventHandler = (
  event: AgentRuntimeEvent,
  tools: AgentRuntimeTools
) =>
  | Promise<
      | AgentEventEmitResult
      | AgentJobEnqueueResult
      | AgentRuntimeActionRequest
      | AgentRuntimeActionResult
      | void
      | null
      | undefined
    >
  | AgentEventEmitResult
  | AgentJobEnqueueResult
  | AgentRuntimeActionRequest
  | AgentRuntimeActionResult
  | void
  | null
  | undefined;

export type AgentEventRegistrationOptions = {
  priority?: number;
  timeoutMs?: number;
};

export type AgentEventRegistry = {
  on: (eventType: string, handler: AgentEventHandler, options?: AgentEventRegistrationOptions) => void;
};

export type AgentActionSelection = {
  winner: AgentEventActionResult | null;
  reconciled: Array<AgentEventActionResult>;
  failed: Array<AgentEventActionResult>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAgentJobEnqueueResult(value: unknown): value is AgentJobEnqueueResult {
  if (!isRecord(value) || !isRecord(value.job)) {
    return false;
  }
  if (value.status !== "enqueued" && value.status !== "already_queued") {
    return false;
  }
  return typeof value.job.id === "string" && typeof value.job.type === "string" && typeof value.job.projectId === "string";
}

export function isAgentRuntimeActionResult(value: unknown): value is AgentRuntimeActionResult {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.actionType !== "string") {
    return false;
  }
  return (
    value.status === "performed" ||
    value.status === "already_resolved" ||
    value.status === "not_eligible" ||
    value.status === "conflict" ||
    value.status === "forbidden" ||
    value.status === "invalid" ||
    value.status === "failed"
  );
}

export function isAgentRuntimeActionRequest(value: unknown): value is AgentRuntimeActionRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind !== "action_request") {
    return false;
  }
  if (typeof value.actionType !== "string") {
    return false;
  }
  return isRecord(value.payload);
}

export function isAgentEventEmitResult(value: unknown): value is AgentEventEmitResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (typeof value.moduleName !== "string") {
    return false;
  }
  if (value.kind === "enqueue_result") {
    return isAgentJobEnqueueResult(value);
  }
  if (value.kind === "action_result") {
    return isAgentRuntimeActionResult(value);
  }
  if (value.kind === "handler_result") {
    return true;
  }
  if (value.kind === "handler_error") {
    return typeof value.eventType === "string" && typeof value.error === "string";
  }
  return false;
}

export function toAgentEventEmitResult(
  moduleName: string,
  eventType: string,
  raw: unknown
): AgentEventEmitResult | null {
  if (isAgentEventEmitResult(raw)) {
    if (raw.moduleName && raw.moduleName.length > 0) {
      return raw;
    }
  }

  if (isAgentJobEnqueueResult(raw)) {
    return {
      kind: "enqueue_result",
      moduleName,
      status: raw.status,
      job: raw.job
    };
  }

  if (isAgentRuntimeActionResult(raw)) {
    return {
      kind: "action_result",
      moduleName,
      actionType: raw.actionType,
      status: raw.status,
      ...(typeof raw.requestId === "string" ? { requestId: raw.requestId } : {}),
      ...(typeof raw.idempotencyKey === "string" ? { idempotencyKey: raw.idempotencyKey } : {}),
      details: raw.details
    };
  }

  if (isRecord(raw) && raw.kind === "handler_result") {
    return {
      kind: "handler_result",
      moduleName,
      ...(isRecord(raw.details) ? { details: raw.details } : {})
    };
  }

  if (raw === undefined || raw === null) {
    return {
      kind: "handler_result",
      moduleName
    };
  }

  return {
    kind: "handler_result",
    moduleName,
    details: {
      value: raw
    }
  };
}

export function toAgentEventHandlerError(moduleName: string, eventType: string, error: unknown): AgentEventHandlerError {
  return {
    kind: "handler_error",
    moduleName,
    eventType,
    error: error instanceof Error ? error.message : String(error)
  };
}

export function selectEnqueueWinner(
  results: Array<AgentEventEmitResult>,
  strategy: "prefer_enqueued" | "prefer_existing" = "prefer_enqueued"
): AgentEventEnqueueResult | null {
  const enqueueResults = results.filter((result): result is AgentEventEnqueueResult => result.kind === "enqueue_result");
  if (enqueueResults.length === 0) {
    return null;
  }

  if (strategy === "prefer_existing") {
    return enqueueResults.find((result) => result.status === "already_queued") ?? enqueueResults[0];
  }

  return (
    enqueueResults.find((result) => result.status === "enqueued") ??
    enqueueResults.find((result) => result.status === "already_queued") ??
    null
  );
}

export function selectFirstSuccessfulAction(results: Array<AgentEventEmitResult>): AgentEventActionResult | null {
  for (const result of results) {
    if (result.kind === "action_result" && result.status === "performed") {
      return result;
    }
  }
  return null;
}

export function classifyReconciledActionStatus(status: AgentRuntimeActionStatus): "reconciled" | "winner" | "failed" {
  if (status === "performed") {
    return "winner";
  }
  if (status === "already_resolved" || status === "not_eligible" || status === "conflict") {
    return "reconciled";
  }
  return "failed";
}

export function selectActionExecutionPlan(results: Array<AgentEventEmitResult>): AgentActionSelection {
  const winner = selectFirstSuccessfulAction(results);
  const reconciled: Array<AgentEventActionResult> = [];
  const failed: Array<AgentEventActionResult> = [];

  for (const result of results) {
    if (result.kind !== "action_result") {
      continue;
    }
    if (winner && result === winner) {
      continue;
    }
    const classified = classifyReconciledActionStatus(result.status);
    if (classified === "failed") {
      failed.push(result);
      continue;
    }
    reconciled.push(result);
  }

  return {
    winner,
    reconciled,
    failed
  };
}
