import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentEventsRuntime } from "./agent-events-runtime.js";

async function withTempAgentsRoot(fn: (agentsRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-events-timeout-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeEventsModule(agentsRoot: string, moduleName: string, source: string): Promise<void> {
  const moduleDir = path.join(agentsRoot, moduleName);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, "events.mjs"), `${source}\n`, "utf8");
}

function runtimeTools(input?: { onEnqueue?: () => void }) {
  return {
    enqueueJob: async () => {
      input?.onEnqueue?.();
      return {
        status: "enqueued" as const,
        job: {
          id: "unused",
          type: "unused",
          projectId: "unused",
          state: "queued" as const
        }
      };
    },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  };
}

test("slow handler timeout does not block other fanout subscribers", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "slow",
      `
export function registerAgentEvents(registry) {
  registry.on(
    "event.timeout",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        status: "enqueued",
        job: { id: "slow-job", type: "suggest_request", projectId: "p1", state: "queued" }
      };
    },
    { priority: 1, timeoutMs: 25 }
  );
}
`
    );

    await writeEventsModule(
      agentsRoot,
      "fast",
      `
export function registerAgentEvents(registry) {
  registry.on("event.timeout", () => ({
    status: "enqueued",
    job: { id: "fast-job", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 2 });
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const startedAt = Date.now();
    const results = await runtime.emit(
      {
        type: "event.timeout",
        payload: {}
      },
      runtimeTools()
    );
    const elapsedMs = Date.now() - startedAt;

    assert.equal(results.length, 2);
    assert.equal(results[0]?.kind, "handler_error");
    assert.equal(results[1]?.kind, "enqueue_result");
    assert.equal(results[1]?.moduleName, "fast");
    assert.ok(elapsedMs < 150, `expected timeout isolation to complete quickly, elapsed=${elapsedMs}ms`);
  });
});

test("timed-out handler cannot enqueue work after timeout", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "late-enqueue",
      `
export function registerAgentEvents(registry) {
  registry.on(
    "event.timeout",
    async (_event, tools) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tools.enqueueJob({
        type: "suggest_request",
        projectId: "p1",
        payload: { draft: "late side effect" }
      });
      return {
        status: "enqueued",
        job: { id: "late-job", type: "suggest_request", projectId: "p1", state: "queued" }
      };
    },
    { timeoutMs: 20 }
  );
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      },
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    let enqueueCount = 0;
    const results = await runtime.emit(
      {
        type: "event.timeout",
        payload: {}
      },
      runtimeTools({
        onEnqueue: () => {
          enqueueCount += 1;
        }
      })
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "handler_error");

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(enqueueCount, 0, "late tool calls after timeout must not enqueue side effects");
  });
});
