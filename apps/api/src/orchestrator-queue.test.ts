import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { OrchestratorQueue } from "./orchestrator-queue.js";
import type {
  JobDefinitionsMap,
  OrchestratorQueueEvent,
  OrchestratorQueueSnapshot,
  OrchestratorQueueStore
} from "./orchestrator-types.js";

class InMemoryStore implements OrchestratorQueueStore {
  public snapshot: OrchestratorQueueSnapshot;

  constructor(initial?: OrchestratorQueueSnapshot) {
    this.snapshot = initial ?? { version: 1, jobs: [] };
  }

  public async load(): Promise<OrchestratorQueueSnapshot> {
    return {
      version: 1,
      jobs: this.snapshot.jobs.map((job) => ({ ...job }))
    };
  }

  public async save(snapshot: OrchestratorQueueSnapshot): Promise<void> {
    this.snapshot = {
      version: snapshot.version,
      jobs: snapshot.jobs.map((job) => ({ ...job }))
    };
  }
}

function createQueue(input: {
  definitions: JobDefinitionsMap;
  store?: InMemoryStore;
  events?: Array<OrchestratorQueueEvent>;
  globalConcurrency?: number;
  backgroundAgingMs?: number;
  maxInteractiveBurst?: number;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
}): { queue: OrchestratorQueue; store: InMemoryStore } {
  const store = input.store ?? new InMemoryStore();
  const events = input.events ?? [];

  const queue = new OrchestratorQueue({
    definitions: input.definitions,
    store,
    globalConcurrency: input.globalConcurrency ?? 1,
    backgroundAgingMs: input.backgroundAgingMs,
    maxInteractiveBurst: input.maxInteractiveBurst,
    hooks: {
      emitEvent: (event) => {
        events.push(event);
      },
      interruptTurn: input.interruptTurn
    }
  });

  return {
    queue,
    store
  };
}

async function waitForState(
  queue: OrchestratorQueue,
  jobId: string,
  expected: "queued" | "running" | "completed" | "failed" | "canceled",
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = queue.get(jobId);
    if (job?.state === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`timed out waiting for ${jobId} -> ${expected}`);
}

test("single-flight dedupe returns existing job identity", async () => {
  const definitions: JobDefinitionsMap = {
    suggest_reply: {
      type: "suggest_reply",
      version: 1,
      priority: "interactive",
      payloadSchema: z.object({ key: z.string() }),
      resultSchema: z.object({ suggestion: z.string() }),
      dedupe: {
        key: (payload) => `k:${(payload as { key: string }).key}`,
        mode: "single_flight"
      },
      retry: {
        maxAttempts: 2,
        classify: () => "fatal",
        baseDelayMs: 10,
        maxDelayMs: 100,
        jitter: false
      },
      timeoutMs: 5_000,
      cancel: {
        strategy: "mark_canceled",
        gracefulWaitMs: 0
      },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          suggestion: "ok"
        };
      }
    }
  };

  const { queue } = createQueue({ definitions });
  await queue.start();

  const first = await queue.enqueue({
    type: "suggest_reply",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { key: "chat-1" }
  });

  const second = await queue.enqueue({
    type: "suggest_reply",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { key: "chat-1" }
  });

  assert.equal(second.status, "already_queued");
  assert.equal(second.job.id, first.job.id);

  const terminal = await queue.waitForTerminal(first.job.id, 2_000);
  assert.equal(terminal?.state, "completed");

  await queue.stop();
});

test("background starvation guard runs aged background job after interactive burst", async () => {
  const runOrder: Array<string> = [];

  const definitions: JobDefinitionsMap = {
    interactive: {
      type: "interactive",
      version: 1,
      priority: "interactive",
      payloadSchema: z.object({ label: z.string() }),
      resultSchema: z.object({ ok: z.boolean() }),
      dedupe: {
        key: () => null,
        mode: "none"
      },
      retry: {
        maxAttempts: 1,
        classify: () => "fatal",
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitter: false
      },
      timeoutMs: 5_000,
      cancel: {
        strategy: "mark_canceled",
        gracefulWaitMs: 0
      },
      run: async (_ctx, payload) => {
        const parsed = payload as { label: string };
        runOrder.push(parsed.label);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      }
    },
    background: {
      type: "background",
      version: 1,
      priority: "background",
      payloadSchema: z.object({ label: z.string() }),
      resultSchema: z.object({ ok: z.boolean() }),
      dedupe: {
        key: () => null,
        mode: "none"
      },
      retry: {
        maxAttempts: 1,
        classify: () => "fatal",
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitter: false
      },
      timeoutMs: 5_000,
      cancel: {
        strategy: "mark_canceled",
        gracefulWaitMs: 0
      },
      run: async (_ctx, payload) => {
        const parsed = payload as { label: string };
        runOrder.push(parsed.label);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: true };
      }
    }
  };

  const { queue } = createQueue({
    definitions,
    backgroundAgingMs: 0,
    maxInteractiveBurst: 2,
    globalConcurrency: 1
  });

  await queue.start();

  const i1 = await queue.enqueue({
    type: "interactive",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { label: "i1" }
  });
  const i2 = await queue.enqueue({
    type: "interactive",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { label: "i2" }
  });
  const background = await queue.enqueue({
    type: "background",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { label: "b1" }
  });
  const i3 = await queue.enqueue({
    type: "interactive",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { label: "i3" }
  });

  const terminals = await Promise.all([
    queue.waitForTerminal(background.job.id, 5_000),
    queue.waitForTerminal(i1.job.id, 5_000),
    queue.waitForTerminal(i2.job.id, 5_000),
    queue.waitForTerminal(i3.job.id, 5_000)
  ]);

  assert.ok(terminals.every((item) => item?.state === "completed"));
  assert.deepEqual(runOrder.slice(0, 3), ["i1", "i2", "b1"]);

  await queue.stop();
});

test("running cancel interrupts the active turn and cancels the job", async () => {
  let interruptedThreadId: string | null = null;
  let interruptedTurnId: string | null = null;

  const definitions: JobDefinitionsMap = {
    interruptible: {
      type: "interruptible",
      version: 1,
      priority: "interactive",
      payloadSchema: z.object({ key: z.string() }),
      resultSchema: z.object({ ok: z.boolean() }),
      dedupe: {
        key: () => null,
        mode: "none"
      },
      retry: {
        maxAttempts: 1,
        classify: () => "fatal",
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitter: false
      },
      timeoutMs: 5_000,
      cancel: {
        strategy: "interrupt_turn",
        gracefulWaitMs: 20
      },
      run: async (ctx) => {
        ctx.setRunningContext({
          threadId: "worker-thread",
          turnId: "turn-1"
        });
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: true };
      }
    }
  };

  const { queue } = createQueue({
    definitions,
    globalConcurrency: 1,
    interruptTurn: async (threadId, turnId) => {
      interruptedThreadId = threadId;
      interruptedTurnId = turnId;
    }
  });

  await queue.start();

  const enqueued = await queue.enqueue({
    type: "interruptible",
    projectId: "p1",
    sourceSessionId: "s1",
    payload: { key: "x" }
  });

  await waitForState(queue, enqueued.job.id, "running", 1_000);
  await queue.cancel(enqueued.job.id, "user_cancel");

  const terminal = await queue.waitForTerminal(enqueued.job.id, 2_000);
  assert.equal(terminal?.state, "canceled");
  assert.equal(interruptedThreadId, "worker-thread");
  assert.equal(interruptedTurnId, "turn-1");

  await queue.stop();
});

test("startup recovery requeues running jobs and enforces max-attempt failure", async () => {
  const store = new InMemoryStore({
    version: 1,
    jobs: [
      {
        id: "job-recover-fail",
        type: "recover",
        version: 1,
        projectId: "p1",
        sourceSessionId: "s1",
        priority: "interactive",
        state: "running",
        dedupeKey: null,
        payload: { label: "will-fail" },
        result: null,
        error: null,
        attempts: 1,
        maxAttempts: 1,
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        startedAt: new Date(Date.now() - 4_000).toISOString(),
        completedAt: null,
        cancelRequestedAt: null,
        nextAttemptAt: null,
        lastAttemptAt: new Date(Date.now() - 4_000).toISOString(),
        runningContext: {
          threadId: "t1",
          turnId: "u1"
        }
      },
      {
        id: "job-recover-requeue",
        type: "recover",
        version: 1,
        projectId: "p1",
        sourceSessionId: "s1",
        priority: "interactive",
        state: "running",
        dedupeKey: null,
        payload: { label: "will-run" },
        result: null,
        error: null,
        attempts: 0,
        maxAttempts: 2,
        createdAt: new Date(Date.now() - 5_000).toISOString(),
        startedAt: new Date(Date.now() - 4_000).toISOString(),
        completedAt: null,
        cancelRequestedAt: null,
        nextAttemptAt: null,
        lastAttemptAt: new Date(Date.now() - 4_000).toISOString(),
        runningContext: {
          threadId: "t2",
          turnId: "u2"
        }
      }
    ]
  });

  const definitions: JobDefinitionsMap = {
    recover: {
      type: "recover",
      version: 1,
      priority: "interactive",
      payloadSchema: z.object({ label: z.string() }),
      resultSchema: z.object({ ok: z.boolean() }),
      dedupe: {
        key: () => null,
        mode: "none"
      },
      retry: {
        maxAttempts: 2,
        classify: () => "fatal",
        baseDelayMs: 10,
        maxDelayMs: 20,
        jitter: false
      },
      timeoutMs: 1_000,
      cancel: {
        strategy: "mark_canceled",
        gracefulWaitMs: 0
      },
      run: async () => ({ ok: true })
    }
  };

  const { queue } = createQueue({
    definitions,
    store,
    globalConcurrency: 1
  });

  await queue.start();

  const failed = queue.get("job-recover-fail");
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error, "recovery_max_attempts_exceeded");

  const completed = await queue.waitForTerminal("job-recover-requeue", 2_000);
  assert.equal(completed?.state, "completed");

  await queue.stop();
});
