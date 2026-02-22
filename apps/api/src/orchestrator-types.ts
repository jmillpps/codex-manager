import type { z } from "zod";

export type OrchestratorJobPriority = "interactive" | "background";
export type OrchestratorJobState = "queued" | "running" | "completed" | "failed" | "canceled";

export type OrchestratorRunningContext = {
  threadId: string | null;
  turnId: string | null;
};

export type OrchestratorJob = {
  id: string;
  type: string;
  version: number;
  projectId: string;
  sourceSessionId: string | null;
  priority: OrchestratorJobPriority;
  state: OrchestratorJobState;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  runningContext: OrchestratorRunningContext;
};

export type OrchestratorQueueSnapshot = {
  version: 1;
  jobs: Array<OrchestratorJob>;
};

export type OrchestratorDedupeMode = "single_flight" | "drop_duplicate" | "merge_duplicate" | "none";

export type OrchestratorRetryClass = "retryable" | "fatal";

export type JobRunContext = {
  readonly jobId: string;
  readonly projectId: string;
  readonly sourceSessionId: string | null;
  readonly attempt: number;
  readonly signal: AbortSignal;
  setRunningContext: (context: OrchestratorRunningContext) => void;
  emitProgress: (progress: Record<string, unknown>) => void;
};

export type JobDefinition<TPayload, TResult extends Record<string, unknown>> = {
  type: string;
  version: number;
  priority: OrchestratorJobPriority;
  payloadSchema: z.ZodType<TPayload>;
  resultSchema: z.ZodType<TResult>;
  dedupe: {
    key: (payload: TPayload) => string | null;
    mode: OrchestratorDedupeMode;
    merge?: (existing: TPayload, incoming: TPayload) => TPayload;
  };
  retry: {
    maxAttempts: number;
    classify: (error: unknown) => OrchestratorRetryClass;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
    delayForAttempt?: (attempt: number) => number;
  };
  timeoutMs: number | null;
  cancel: {
    strategy: "interrupt_turn" | "mark_canceled";
    gracefulWaitMs: number;
  };
  run: (ctx: JobRunContext, payload: TPayload) => Promise<TResult>;
  onQueued?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
  onStarted?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
  onCompleted?: (ctx: JobRunContext, payload: TPayload, result: TResult, jobId: string) => Promise<void>;
  onFailed?: (ctx: JobRunContext, payload: TPayload, error: string, jobId: string) => Promise<void>;
  onCanceled?: (ctx: JobRunContext, payload: TPayload, jobId: string) => Promise<void>;
};

export type JobDefinitionsMap = Record<string, JobDefinition<unknown, Record<string, unknown>>>;

export type OrchestratorQueueEventType =
  | "orchestrator_job_queued"
  | "orchestrator_job_started"
  | "orchestrator_job_progress"
  | "orchestrator_job_completed"
  | "orchestrator_job_failed"
  | "orchestrator_job_canceled";

export type OrchestratorQueueEvent = {
  type: OrchestratorQueueEventType;
  threadId: string | null;
  payload: {
    jobId: string;
    projectId: string;
    jobType: string;
    state: OrchestratorJobState;
    sourceSessionId?: string;
    result?: Record<string, unknown>;
    error?: string;
    progress?: Record<string, unknown>;
  };
};

export type OrchestratorQueueLogger = {
  debug: (input: Record<string, unknown>, message?: string) => void;
  info: (input: Record<string, unknown>, message?: string) => void;
  warn: (input: Record<string, unknown>, message?: string) => void;
  error: (input: Record<string, unknown>, message?: string) => void;
};

export type OrchestratorQueueHooks = {
  emitEvent?: (event: OrchestratorQueueEvent) => void;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
};

export type OrchestratorQueueStore = {
  load: () => Promise<OrchestratorQueueSnapshot>;
  save: (snapshot: OrchestratorQueueSnapshot) => Promise<void>;
};

export type EnqueueJobInput = {
  type: string;
  projectId: string;
  sourceSessionId?: string | null;
  payload: Record<string, unknown>;
};

export type EnqueueJobResult = {
  status: "enqueued" | "already_queued";
  job: OrchestratorJob;
};

export type CancelJobResult = {
  status: "canceled" | "already_terminal" | "not_found";
  job: OrchestratorJob | null;
};
