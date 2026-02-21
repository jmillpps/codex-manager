import { randomUUID } from "node:crypto";
import type {
  CancelJobResult,
  EnqueueJobInput,
  EnqueueJobResult,
  JobDefinition,
  JobDefinitionsMap,
  JobRunContext,
  OrchestratorJob,
  OrchestratorJobPriority,
  OrchestratorQueueHooks,
  OrchestratorQueueLogger,
  OrchestratorQueueSnapshot,
  OrchestratorQueueStore,
  OrchestratorRetryClass
} from "./orchestrator-types.js";

const TERMINAL_STATES = new Set<OrchestratorJob["state"]>(["completed", "failed", "canceled"]);

type RunningJobRuntime = {
  controller: AbortController;
  timeoutTimer: NodeJS.Timeout | null;
  cancelTimer: NodeJS.Timeout | null;
  timeoutTriggered: boolean;
};

type QueueDrainOptions = {
  drainMs?: number;
};

type OrchestratorQueueOptions = {
  definitions: JobDefinitionsMap;
  store: OrchestratorQueueStore;
  hooks?: OrchestratorQueueHooks;
  logger?: OrchestratorQueueLogger | null;
  now?: () => number;
  globalConcurrency?: number;
  maxPerProject?: number;
  maxGlobal?: number;
  backgroundAgingMs?: number;
  maxInteractiveBurst?: number;
  defaultMaxAttempts?: number;
  defaultTimeoutMs?: number;
  terminalRetentionPerProject?: number;
};

export class OrchestratorQueueError extends Error {
  public readonly code: "queue_full" | "job_conflict" | "unknown_job_type" | "invalid_payload";
  public readonly statusCode: number;

  constructor(
    code: "queue_full" | "job_conflict" | "unknown_job_type" | "invalid_payload",
    message: string,
    statusCode: number
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function toEpochMs(value: string | null | undefined): number {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function serializeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }

  return "unknown orchestrator error";
}

function terminalRetentionGroupPriority(job: OrchestratorJob): number {
  if (job.state === "failed") {
    return 2;
  }
  if (job.state === "canceled") {
    return 1;
  }
  return 0;
}

export class OrchestratorQueue {
  private readonly definitions: JobDefinitionsMap;
  private readonly store: OrchestratorQueueStore;
  private readonly hooks: OrchestratorQueueHooks;
  private readonly logger: OrchestratorQueueLogger | null;
  private readonly now: () => number;
  private readonly globalConcurrency: number;
  private readonly maxPerProject: number;
  private readonly maxGlobal: number;
  private readonly backgroundAgingMs: number;
  private readonly maxInteractiveBurst: number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultTimeoutMs: number;
  private readonly terminalRetentionPerProject: number;

  private readonly jobsById = new Map<string, OrchestratorJob>();
  private readonly runningRuntimeByJobId = new Map<string, RunningJobRuntime>();
  private readonly runningPromiseByJobId = new Map<string, Promise<void>>();
  private readonly interactiveBurstByProject = new Map<string, number>();
  private readonly terminalWaiters = new Map<string, Array<(job: OrchestratorJob) => void>>();

  private started = false;
  private stopping = false;
  private processing = false;
  private processingQueued = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: OrchestratorQueueOptions) {
    this.definitions = options.definitions;
    this.store = options.store;
    this.hooks = options.hooks ?? {};
    this.logger = options.logger ?? null;
    this.now = options.now ?? Date.now;
    this.globalConcurrency = Math.max(1, options.globalConcurrency ?? 2);
    this.maxPerProject = Math.max(1, options.maxPerProject ?? 100);
    this.maxGlobal = Math.max(1, options.maxGlobal ?? 500);
    this.backgroundAgingMs = Math.max(0, options.backgroundAgingMs ?? 15_000);
    this.maxInteractiveBurst = Math.max(1, options.maxInteractiveBurst ?? 3);
    this.defaultMaxAttempts = Math.max(1, options.defaultMaxAttempts ?? 2);
    this.defaultTimeoutMs = Math.max(1_000, options.defaultTimeoutMs ?? 60_000);
    this.terminalRetentionPerProject = Math.max(10, options.terminalRetentionPerProject ?? 200);
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const snapshot = await this.store.load();
    const recoveredSnapshot = this.recoverSnapshot(snapshot);

    for (const job of recoveredSnapshot.jobs) {
      this.jobsById.set(job.id, job);
    }

    await this.persistSnapshot();
    this.started = true;
    this.stopping = false;
    this.scheduleProcessing();
  }

  public async stop(options?: QueueDrainOptions): Promise<void> {
    if (!this.started) {
      return;
    }

    this.stopping = true;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    const drainMs = Math.max(0, options?.drainMs ?? 0);
    const deadline = this.now() + drainMs;

    if (drainMs > 0) {
      while (this.runningPromiseByJobId.size > 0 && this.now() < deadline) {
        await this.waitForRunningSettle(Math.min(200, Math.max(50, deadline - this.now())));
      }
    }

    if (this.runningPromiseByJobId.size > 0) {
      const runningJobs = Array.from(this.runningPromiseByJobId.keys());
      await Promise.all(runningJobs.map((jobId) => this.cancel(jobId, "shutdown")));
      await Promise.all(Array.from(this.runningPromiseByJobId.values()));
    }

    await this.persistChain;
    this.stopping = false;
    this.started = false;
  }

  public get(jobId: string): OrchestratorJob | null {
    const job = this.jobsById.get(jobId);
    return job ? { ...job } : null;
  }

  public listByProject(projectId: string, state?: OrchestratorJob["state"]): Array<OrchestratorJob> {
    const jobs: Array<OrchestratorJob> = [];
    for (const job of this.jobsById.values()) {
      if (job.projectId !== projectId) {
        continue;
      }
      if (state && job.state !== state) {
        continue;
      }
      jobs.push({ ...job });
    }
    jobs.sort((left, right) => toEpochMs(left.createdAt) - toEpochMs(right.createdAt));
    return jobs;
  }

  public async enqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
    if (!this.started) {
      throw new OrchestratorQueueError("job_conflict", "orchestrator queue is not running", 409);
    }

    const definition = this.resolveDefinition(input.type);
    const payload = definition.payloadSchema.parse(input.payload);
    const dedupeKey = definition.dedupe.key(payload);

    const duplicate = this.findDuplicate(definition, input.projectId, dedupeKey, payload);
    if (duplicate) {
      return {
        status: "already_queued",
        job: { ...duplicate }
      };
    }

    this.assertQueueCapacity(input.projectId);

    const nowIso = new Date(this.now()).toISOString();
    const job: OrchestratorJob = {
      id: randomUUID(),
      type: definition.type,
      version: definition.version,
      projectId: input.projectId,
      sourceSessionId: input.sourceSessionId ?? null,
      priority: definition.priority,
      state: "queued",
      dedupeKey,
      payload: payload as Record<string, unknown>,
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: Math.max(1, definition.retry.maxAttempts || this.defaultMaxAttempts),
      createdAt: nowIso,
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      nextAttemptAt: null,
      lastAttemptAt: null,
      runningContext: {
        threadId: null,
        turnId: null
      }
    };

    this.jobsById.set(job.id, job);
    this.trimTerminalHistoryForProject(job.projectId);
    await this.persistSnapshot();

    await this.safeRunHook(job, () => definition.onQueued?.(this.noopContext(job), payload, job.id));
    this.emitJobEvent("orchestrator_job_queued", job);
    this.scheduleProcessing();

    return {
      status: "enqueued",
      job: { ...job }
    };
  }

  public async cancel(jobId: string, reason = "cancel_requested"): Promise<CancelJobResult> {
    const job = this.jobsById.get(jobId);
    if (!job) {
      return {
        status: "not_found",
        job: null
      };
    }

    if (TERMINAL_STATES.has(job.state)) {
      return {
        status: "already_terminal",
        job: { ...job }
      };
    }

    if (job.state === "queued") {
      await this.transitionToCanceled(job, reason);
      this.scheduleProcessing();
      return {
        status: "canceled",
        job: { ...job }
      };
    }

    job.cancelRequestedAt = new Date(this.now()).toISOString();
    await this.persistSnapshot();

    const runtime = this.runningRuntimeByJobId.get(job.id);
    if (!runtime) {
      await this.transitionToCanceled(job, reason);
      return {
        status: "canceled",
        job: { ...job }
      };
    }

    const definition = this.resolveDefinition(job.type);

    if (definition.cancel.strategy === "mark_canceled") {
      runtime.controller.abort(`job canceled: ${reason}`);
      await this.transitionToCanceled(job, reason);
      return {
        status: "canceled",
        job: { ...job }
      };
    }

    const runningThreadId = job.runningContext.threadId;
    const runningTurnId = job.runningContext.turnId;
    if (runningThreadId && runningTurnId && this.hooks.interruptTurn) {
      this.hooks
        .interruptTurn(runningThreadId, runningTurnId)
        .catch((error) => {
          this.logger?.warn(
            {
              error,
              jobId: job.id,
              threadId: runningThreadId,
              turnId: runningTurnId
            },
            "orchestrator queue cancel interrupt failed"
          );
        });
    }

    if (!runtime.cancelTimer) {
      runtime.cancelTimer = setTimeout(() => {
        runtime.controller.abort(`job interrupt timeout: ${reason}`);
        const latest = this.jobsById.get(job.id);
        if (!latest || latest.state !== "running") {
          return;
        }
        void this.transitionToCanceled(latest, "interrupt_timeout");
      }, Math.max(0, definition.cancel.gracefulWaitMs));
    }

    return {
      status: "canceled",
      job: { ...job }
    };
  }

  public async waitForTerminal(jobId: string, timeoutMs: number): Promise<OrchestratorJob | null> {
    const existing = this.jobsById.get(jobId);
    if (existing && TERMINAL_STATES.has(existing.state)) {
      return { ...existing };
    }

    return new Promise<OrchestratorJob | null>((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.terminalWaiters.get(jobId) ?? [];
        this.terminalWaiters.set(
          jobId,
          waiters.filter((waiter) => waiter !== onComplete)
        );
        resolve(null);
      }, Math.max(1, timeoutMs));

      const onComplete = (job: OrchestratorJob): void => {
        clearTimeout(timer);
        resolve({ ...job });
      };

      const waiters = this.terminalWaiters.get(jobId) ?? [];
      waiters.push(onComplete);
      this.terminalWaiters.set(jobId, waiters);
    });
  }

  private scheduleProcessing(delayMs = 0): void {
    if (!this.started || this.stopping) {
      return;
    }

    if (delayMs > 0) {
      if (this.wakeTimer) {
        return;
      }
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.scheduleProcessing();
      }, delayMs);
      return;
    }

    if (this.processingQueued) {
      return;
    }

    this.processingQueued = true;
    queueMicrotask(() => {
      this.processingQueued = false;
      void this.processLoop();
    });
  }

  private async processLoop(): Promise<void> {
    if (this.processing || !this.started || this.stopping) {
      return;
    }

    this.processing = true;
    try {
      while (this.runningPromiseByJobId.size < this.globalConcurrency) {
        const nextJob = this.nextRunnableJob();
        if (!nextJob) {
          const nextRetryAtMs = this.nextRetryWakeAtMs();
          if (Number.isFinite(nextRetryAtMs)) {
            const delay = Math.max(10, nextRetryAtMs - this.now());
            this.scheduleProcessing(delay);
          }
          break;
        }

        const runPromise = this.runJob(nextJob)
          .catch((error) => {
            this.logger?.error(
              {
                error,
                jobId: nextJob.id,
                type: nextJob.type,
                projectId: nextJob.projectId
              },
              "orchestrator queue run failure"
            );
          })
          .finally(() => {
            this.runningPromiseByJobId.delete(nextJob.id);
            this.scheduleProcessing();
          });

        this.runningPromiseByJobId.set(nextJob.id, runPromise);
      }
    } finally {
      this.processing = false;
    }
  }

  private nextRetryWakeAtMs(): number {
    let soonest = Number.POSITIVE_INFINITY;
    const now = this.now();

    for (const job of this.jobsById.values()) {
      if (job.state !== "queued" || !job.nextAttemptAt) {
        continue;
      }
      const retryAt = Date.parse(job.nextAttemptAt);
      if (!Number.isFinite(retryAt) || retryAt <= now) {
        continue;
      }
      soonest = Math.min(soonest, retryAt);
    }

    return soonest;
  }

  private nextRunnableJob(): OrchestratorJob | null {
    const now = this.now();
    const queuedByProject = new Map<string, Array<OrchestratorJob>>();

    for (const job of this.jobsById.values()) {
      if (job.state !== "queued") {
        continue;
      }

      if (job.nextAttemptAt) {
        const retryAt = Date.parse(job.nextAttemptAt);
        if (Number.isFinite(retryAt) && retryAt > now) {
          continue;
        }
      }

      if (this.hasRunningJobForProject(job.projectId)) {
        continue;
      }

      const bucket = queuedByProject.get(job.projectId);
      if (bucket) {
        bucket.push(job);
      } else {
        queuedByProject.set(job.projectId, [job]);
      }
    }

    const candidates: Array<{ job: OrchestratorJob; forcedBackground: boolean }> = [];

    for (const [projectId, jobs] of queuedByProject.entries()) {
      jobs.sort((left, right) => toEpochMs(left.createdAt) - toEpochMs(right.createdAt));

      const interactiveJobs = jobs.filter((job) => job.priority === "interactive");
      const backgroundJobs = jobs.filter((job) => job.priority === "background");
      const burst = this.interactiveBurstByProject.get(projectId) ?? 0;

      const agedBackground = backgroundJobs.find((job) => {
        const ageMs = now - toEpochMs(job.createdAt);
        return ageMs >= this.backgroundAgingMs;
      });

      if (agedBackground && burst >= this.maxInteractiveBurst) {
        candidates.push({
          job: agedBackground,
          forcedBackground: true
        });
        continue;
      }

      if (interactiveJobs.length > 0) {
        candidates.push({
          job: interactiveJobs[0],
          forcedBackground: false
        });
        continue;
      }

      if (backgroundJobs.length > 0) {
        candidates.push({
          job: backgroundJobs[0],
          forcedBackground: false
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      if (left.forcedBackground !== right.forcedBackground) {
        return left.forcedBackground ? -1 : 1;
      }

      if (left.job.priority !== right.job.priority) {
        return left.job.priority === "interactive" ? -1 : 1;
      }

      return toEpochMs(left.job.createdAt) - toEpochMs(right.job.createdAt);
    });

    return candidates[0].job;
  }

  private async runJob(job: OrchestratorJob): Promise<void> {
    const definition = this.resolveDefinition(job.type);
    const payload = definition.payloadSchema.parse(job.payload);
    const controller = new AbortController();
    const runtime: RunningJobRuntime = {
      controller,
      timeoutTimer: null,
      cancelTimer: null,
      timeoutTriggered: false
    };

    const nowIso = new Date(this.now()).toISOString();
    job.state = "running";
    job.startedAt = nowIso;
    job.lastAttemptAt = nowIso;
    job.nextAttemptAt = null;
    job.error = null;
    job.result = null;
    job.cancelRequestedAt = null;
    job.attempts += 1;
    job.runningContext = {
      threadId: null,
      turnId: null
    };

    this.runningRuntimeByJobId.set(job.id, runtime);
    if (job.priority === "interactive") {
      this.interactiveBurstByProject.set(job.projectId, (this.interactiveBurstByProject.get(job.projectId) ?? 0) + 1);
    } else {
      this.interactiveBurstByProject.set(job.projectId, 0);
    }

    await this.persistSnapshot();

    const jobContext: JobRunContext = {
      jobId: job.id,
      projectId: job.projectId,
      sourceSessionId: job.sourceSessionId,
      attempt: job.attempts,
      signal: controller.signal,
      setRunningContext: (context) => {
        const current = this.jobsById.get(job.id);
        if (!current || current.state !== "running") {
          return;
        }
        current.runningContext = {
          threadId: context.threadId,
          turnId: context.turnId
        };
        void this.persistSnapshot();
      },
      emitProgress: (progress) => {
        const current = this.jobsById.get(job.id);
        if (!current || current.state !== "running") {
          return;
        }

        this.emitJobEvent("orchestrator_job_progress", current, {
          progress
        });
      }
    };

    const timeoutMs = definition.timeoutMs ?? this.defaultTimeoutMs;
    if (timeoutMs > 0) {
      runtime.timeoutTimer = setTimeout(() => {
        runtime.timeoutTriggered = true;
        controller.abort("orchestrator job timeout");
      }, timeoutMs);
    }

    await this.safeRunHook(job, () => definition.onStarted?.(jobContext, payload, job.id));
    this.emitJobEvent("orchestrator_job_started", job);

    try {
      const rawResult = await definition.run(jobContext, payload);
      const result = definition.resultSchema.parse(rawResult);
      const current = this.jobsById.get(job.id);
      if (!current || current.state !== "running") {
        return;
      }

      if (runtime.timeoutTriggered) {
        await this.handleFailureForRetry(current, definition, payload, new Error("orchestrator job timeout"));
        return;
      }

      if (current.cancelRequestedAt) {
        await this.transitionToCanceled(current, "cancel_requested");
        return;
      }

      await this.transitionToCompleted(current, result);
      await this.safeRunHook(current, () => definition.onCompleted?.(jobContext, payload, result, current.id));
    } catch (error) {
      const current = this.jobsById.get(job.id);
      if (!current || current.state !== "running") {
        return;
      }

      if (current.cancelRequestedAt) {
        await this.transitionToCanceled(current, "cancel_requested");
        return;
      }

      if (runtime.timeoutTriggered) {
        await this.handleFailureForRetry(current, definition, payload, new Error("orchestrator job timeout"));
        return;
      }

      await this.handleFailureForRetry(current, definition, payload, error);
    } finally {
      this.clearRuntime(job.id);
    }
  }

  private async handleFailureForRetry(
    job: OrchestratorJob,
    definition: JobDefinition<unknown, Record<string, unknown>>,
    payload: unknown,
    error: unknown
  ): Promise<void> {
    const errorMessage = serializeError(error);
    const classify: OrchestratorRetryClass = definition.retry.classify(error);

    if (classify === "retryable" && job.attempts < job.maxAttempts) {
      const delayMs = this.computeRetryDelayMs(definition, job.attempts);
      job.state = "queued";
      job.error = errorMessage;
      job.startedAt = null;
      job.completedAt = null;
      job.nextAttemptAt = new Date(this.now() + delayMs).toISOString();
      job.runningContext = {
        threadId: null,
        turnId: null
      };
      await this.persistSnapshot();
      this.scheduleProcessing(delayMs);
      return;
    }

    await this.transitionToFailed(job, errorMessage);
    await this.safeRunHook(job, () => definition.onFailed?.(this.noopContext(job), payload, errorMessage, job.id));
  }

  private computeRetryDelayMs(definition: JobDefinition<unknown, Record<string, unknown>>, attempt: number): number {
    const baseDelayMs = Math.max(100, definition.retry.baseDelayMs);
    const maxDelayMs = Math.max(baseDelayMs, definition.retry.maxDelayMs);
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));

    if (!definition.retry.jitter) {
      return exponential;
    }

    const spread = Math.floor(exponential * 0.4);
    const jitter = Math.floor(Math.random() * (spread + 1));
    return Math.max(100, exponential - Math.floor(spread / 2) + jitter);
  }

  private async transitionToCompleted(job: OrchestratorJob, result: Record<string, unknown>): Promise<void> {
    job.state = "completed";
    job.result = result;
    job.error = null;
    job.completedAt = new Date(this.now()).toISOString();
    job.nextAttemptAt = null;
    job.runningContext = {
      threadId: null,
      turnId: null
    };

    this.trimTerminalHistoryForProject(job.projectId);
    await this.persistSnapshot();
    this.emitJobEvent("orchestrator_job_completed", job, { result });
    this.resolveTerminalWaiters(job);
  }

  private async transitionToFailed(job: OrchestratorJob, error: string): Promise<void> {
    job.state = "failed";
    job.error = error;
    job.completedAt = new Date(this.now()).toISOString();
    job.nextAttemptAt = null;
    job.runningContext = {
      threadId: null,
      turnId: null
    };

    this.trimTerminalHistoryForProject(job.projectId);
    await this.persistSnapshot();
    this.emitJobEvent("orchestrator_job_failed", job, { error });
    this.resolveTerminalWaiters(job);
  }

  private async transitionToCanceled(job: OrchestratorJob, reason: string): Promise<void> {
    const definition = this.resolveDefinition(job.type);
    const payload = definition.payloadSchema.parse(job.payload);

    job.state = "canceled";
    job.error = reason;
    job.completedAt = new Date(this.now()).toISOString();
    job.nextAttemptAt = null;
    job.runningContext = {
      threadId: null,
      turnId: null
    };

    this.trimTerminalHistoryForProject(job.projectId);
    await this.persistSnapshot();
    this.emitJobEvent("orchestrator_job_canceled", job, { error: reason });
    await this.safeRunHook(job, () => definition.onCanceled?.(this.noopContext(job), payload, job.id));
    this.resolveTerminalWaiters(job);
  }

  private clearRuntime(jobId: string): void {
    const runtime = this.runningRuntimeByJobId.get(jobId);
    if (runtime) {
      if (runtime.timeoutTimer) {
        clearTimeout(runtime.timeoutTimer);
      }
      if (runtime.cancelTimer) {
        clearTimeout(runtime.cancelTimer);
      }
      this.runningRuntimeByJobId.delete(jobId);
    }
  }

  private hasRunningJobForProject(projectId: string): boolean {
    for (const jobId of this.runningPromiseByJobId.keys()) {
      const job = this.jobsById.get(jobId);
      if (job?.projectId === projectId) {
        return true;
      }
    }

    return false;
  }

  private emitJobEvent(
    type: "orchestrator_job_queued" | "orchestrator_job_started" | "orchestrator_job_progress" | "orchestrator_job_completed" | "orchestrator_job_failed" | "orchestrator_job_canceled",
    job: OrchestratorJob,
    extra?: {
      result?: Record<string, unknown>;
      error?: string;
      progress?: Record<string, unknown>;
    }
  ): void {
    this.hooks.emitEvent?.({
      type,
      threadId: job.sourceSessionId,
      payload: {
        jobId: job.id,
        projectId: job.projectId,
        jobType: job.type,
        state: job.state,
        ...(job.sourceSessionId ? { sourceSessionId: job.sourceSessionId } : {}),
        ...(extra?.result ? { result: extra.result } : {}),
        ...(extra?.error ? { error: extra.error } : {}),
        ...(extra?.progress ? { progress: extra.progress } : {})
      }
    });
  }

  private resolveTerminalWaiters(job: OrchestratorJob): void {
    const waiters = this.terminalWaiters.get(job.id);
    if (!waiters || waiters.length === 0) {
      return;
    }

    this.terminalWaiters.delete(job.id);
    for (const waiter of waiters) {
      waiter(job);
    }
  }

  private resolveDefinition(type: string): JobDefinition<unknown, Record<string, unknown>> {
    const definition = this.definitions[type];
    if (!definition) {
      throw new OrchestratorQueueError("unknown_job_type", `unknown orchestrator job type: ${type}`, 409);
    }

    return definition;
  }

  private assertQueueCapacity(projectId: string): void {
    let globalActive = 0;
    let projectActive = 0;

    for (const job of this.jobsById.values()) {
      if (job.state !== "queued" && job.state !== "running") {
        continue;
      }

      globalActive += 1;
      if (job.projectId === projectId) {
        projectActive += 1;
      }
    }

    if (globalActive >= this.maxGlobal) {
      throw new OrchestratorQueueError("queue_full", "orchestrator queue is at global capacity", 429);
    }

    if (projectActive >= this.maxPerProject) {
      throw new OrchestratorQueueError("queue_full", "orchestrator queue is at project capacity", 429);
    }
  }

  private findDuplicate(
    definition: JobDefinition<unknown, Record<string, unknown>>,
    projectId: string,
    dedupeKey: string | null,
    incomingPayload: unknown
  ): OrchestratorJob | null {
    if (!dedupeKey || definition.dedupe.mode === "none") {
      return null;
    }

    for (const job of this.jobsById.values()) {
      if (job.projectId !== projectId || job.type !== definition.type || job.dedupeKey !== dedupeKey) {
        continue;
      }

      if (definition.dedupe.mode === "single_flight") {
        if (job.state === "queued" || job.state === "running") {
          return job;
        }
        continue;
      }

      if (definition.dedupe.mode === "drop_duplicate") {
        return job;
      }

      if (definition.dedupe.mode === "merge_duplicate") {
        if (job.state !== "queued" && job.state !== "running") {
          continue;
        }

        if (definition.dedupe.merge) {
          try {
            const existingPayload = definition.payloadSchema.parse(job.payload);
            const mergedPayload = definition.dedupe.merge(existingPayload, incomingPayload);
            job.payload = definition.payloadSchema.parse(mergedPayload) as Record<string, unknown>;
            void this.persistSnapshot();
          } catch (error) {
            this.logger?.warn(
              {
                error,
                jobId: job.id,
                type: job.type
              },
              "orchestrator queue failed to merge duplicate payload"
            );
          }
        }

        return job;
      }
    }

    return null;
  }

  private recoverSnapshot(snapshot: OrchestratorQueueSnapshot): OrchestratorQueueSnapshot {
    const nowIso = new Date(this.now()).toISOString();
    const recoveredJobs: Array<OrchestratorJob> = [];

    for (const rawJob of snapshot.jobs) {
      const definition = this.definitions[rawJob.type];
      if (!definition) {
        continue;
      }

      let payload: Record<string, unknown>;
      try {
        payload = definition.payloadSchema.parse(rawJob.payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      const normalized: OrchestratorJob = {
        ...rawJob,
        payload,
        priority: definition.priority,
        version: definition.version,
        maxAttempts: Math.max(1, rawJob.maxAttempts || definition.retry.maxAttempts || this.defaultMaxAttempts),
        runningContext: {
          threadId: rawJob.runningContext?.threadId ?? null,
          turnId: rawJob.runningContext?.turnId ?? null
        }
      };

      if (normalized.state !== "running") {
        recoveredJobs.push(normalized);
        continue;
      }

      normalized.startedAt = null;
      normalized.runningContext = {
        threadId: null,
        turnId: null
      };

      if (normalized.attempts >= normalized.maxAttempts) {
        normalized.state = "failed";
        normalized.error = "recovery_max_attempts_exceeded";
        normalized.completedAt = nowIso;
        normalized.nextAttemptAt = null;
      } else {
        normalized.state = "queued";
        normalized.error = "recovered_from_running_state";
        normalized.completedAt = null;
        normalized.cancelRequestedAt = null;
        normalized.nextAttemptAt = nowIso;
      }

      recoveredJobs.push(normalized);
    }

    return {
      version: 1,
      jobs: recoveredJobs
    };
  }

  private trimTerminalHistoryForProject(projectId: string): void {
    const terminalJobs: Array<OrchestratorJob> = [];
    for (const job of this.jobsById.values()) {
      if (job.projectId !== projectId || !TERMINAL_STATES.has(job.state)) {
        continue;
      }
      terminalJobs.push(job);
    }

    if (terminalJobs.length <= this.terminalRetentionPerProject) {
      return;
    }

    terminalJobs.sort((left, right) => {
      const priorityDiff = terminalRetentionGroupPriority(right) - terminalRetentionGroupPriority(left);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return toEpochMs(right.completedAt) - toEpochMs(left.completedAt);
    });

    const keep = new Set(terminalJobs.slice(0, this.terminalRetentionPerProject).map((job) => job.id));
    for (const job of terminalJobs) {
      if (keep.has(job.id)) {
        continue;
      }
      this.jobsById.delete(job.id);
      this.terminalWaiters.delete(job.id);
    }
  }

  private noopContext(job: OrchestratorJob): JobRunContext {
    const controller = new AbortController();
    return {
      jobId: job.id,
      projectId: job.projectId,
      sourceSessionId: job.sourceSessionId,
      attempt: job.attempts,
      signal: controller.signal,
      setRunningContext: () => undefined,
      emitProgress: () => undefined
    };
  }

  private async safeRunHook(
    job: OrchestratorJob,
    runHook: () => Promise<void> | undefined
  ): Promise<void> {
    try {
      await runHook();
    } catch (error) {
      this.logger?.warn(
        {
          error,
          jobId: job.id,
          type: job.type
        },
        "orchestrator queue hook failed"
      );
    }
  }

  private async persistSnapshot(): Promise<void> {
    const snapshot: OrchestratorQueueSnapshot = {
      version: 1,
      jobs: Array.from(this.jobsById.values()).sort((left, right) => toEpochMs(left.createdAt) - toEpochMs(right.createdAt))
    };

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.store.save(snapshot));

    await this.persistChain;
  }

  private async waitForRunningSettle(timeoutMs: number): Promise<void> {
    const pending = Array.from(this.runningPromiseByJobId.values());
    if (pending.length === 0) {
      return;
    }

    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
  }
}
