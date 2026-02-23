import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentEventsRuntime } from "./agent-events-runtime.js";

type LoggerRecord = {
  level: "debug" | "info" | "warn" | "error";
  input: Record<string, unknown>;
  message?: string;
};

function createLogger(records: Array<LoggerRecord>) {
  return {
    debug: (input: Record<string, unknown>, message?: string): void => {
      records.push({ level: "debug", input, message });
    },
    info: (input: Record<string, unknown>, message?: string): void => {
      records.push({ level: "info", input, message });
    },
    warn: (input: Record<string, unknown>, message?: string): void => {
      records.push({ level: "warn", input, message });
    },
    error: (input: Record<string, unknown>, message?: string): void => {
      records.push({ level: "error", input, message });
    }
  };
}

async function withTempAgentsRoot(fn: (agentsRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-events-runtime-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeEventsModule(
  agentsRoot: string,
  moduleName: string,
  source: string,
  extension: "js" | "mjs" | "ts" = "mjs"
): Promise<void> {
  const moduleDir = path.join(agentsRoot, moduleName);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, `events.${extension}`), `${source}\n`, "utf8");
}

async function writeManifest(
  agentsRoot: string,
  moduleName: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const moduleDir = path.join(agentsRoot, moduleName);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, "extension.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function runtimeTools() {
  return {
    enqueueJob: async () => ({
      status: "enqueued" as const,
      job: {
        id: "unused",
        type: "unused",
        projectId: "unused",
        state: "queued" as const
      }
    }),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
  };
}

test("emit returns empty array when no handlers are registered", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    const records: Array<LoggerRecord> = [];
    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger(records),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "suggest_request.requested",
        payload: {}
      },
      runtimeTools()
    );

    assert.deepEqual(results, []);
  });
});

test("typed action_request executes through internal action executor", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "action-agent",
      `
export function registerAgentEvents(registry) {
  registry.on("event.action", () => ({
    kind: "action_request",
    actionType: "transcript.upsert",
    payload: {
      sessionId: "s1",
      entry: {
        messageId: "m1",
        turnId: "t1",
        role: "system",
        type: "fileChange.explainability",
        content: "Queued explainability analysis...",
        status: "streaming"
      }
    }
  }));
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const executed: Array<{ actionType: string; payload: Record<string, unknown> }> = [];
    const results = await runtime.emit(
      {
        type: "event.action",
        payload: {}
      },
      runtimeTools(),
      {
        executeAction: async (action) => {
          executed.push({
            actionType: action.actionType,
            payload: action.payload
          });
          return {
            actionType: action.actionType,
            status: "performed",
            details: {
              ok: true
            }
          };
        }
      }
    );

    assert.equal(executed.length, 1);
    assert.equal(executed[0]?.actionType, "transcript.upsert");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "action_result");
    assert.equal(results[0]?.status, "performed");
  });
});

test("first performed action wins and later action requests reconcile as not_eligible", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "alpha-action",
      `
export function registerAgentEvents(registry) {
  registry.on("event.action", () => ({
    kind: "action_request",
    actionType: "transcript.upsert",
    payload: {
      sessionId: "s1",
      entry: {
        messageId: "m-alpha",
        turnId: "t1",
        role: "system",
        type: "fileChange.explainability",
        content: "alpha",
        status: "streaming"
      }
    }
  }), { priority: 10 });
}
`
    );
    await writeEventsModule(
      agentsRoot,
      "beta-action",
      `
export function registerAgentEvents(registry) {
  registry.on("event.action", () => ({
    kind: "action_request",
    actionType: "approval.decide",
    payload: {
      approvalId: "approval-1",
      decision: "accept"
    }
  }), { priority: 20 });
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const executed: Array<string> = [];
    const results = await runtime.emit(
      {
        type: "event.action",
        payload: {}
      },
      runtimeTools(),
      {
        executeAction: async (action) => {
          executed.push(action.actionType);
          return {
            actionType: action.actionType,
            status: "performed"
          };
        }
      }
    );

    assert.deepEqual(executed, ["transcript.upsert"]);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.kind, "action_result");
    assert.equal(results[0]?.moduleName, "alpha-action");
    assert.equal(results[0]?.status, "performed");
    assert.equal(results[1]?.kind, "action_result");
    assert.equal(results[1]?.moduleName, "beta-action");
    assert.equal(results[1]?.status, "not_eligible");
    assert.equal((results[1]?.details as { code?: string } | undefined)?.code, "action_winner_already_selected");
  });
});

test("action_request fails when internal action executor is unavailable", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "action-agent",
      `
export function registerAgentEvents(registry) {
  registry.on("event.action", () => ({
    kind: "action_request",
    actionType: "transcript.upsert",
    payload: {
      sessionId: "s1",
      entry: {
        messageId: "m1",
        turnId: "t1",
        role: "system",
        type: "fileChange.explainability",
        content: "Queued explainability analysis...",
        status: "streaming"
      }
    }
  }));
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.action",
        payload: {}
      },
      runtimeTools()
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "action_result");
    assert.equal(results[0]?.status, "failed");
    assert.equal((results[0]?.details as { code?: string } | undefined)?.code, "action_executor_unavailable");
  });
});

test("handler tools do not expose direct action execution", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "unsafe-agent",
      `
export function registerAgentEvents(registry) {
  registry.on("event.unsafe", async (_event, tools) => {
    if (typeof tools.performAction === "function") {
      return await tools.performAction({
        kind: "action_request",
        actionType: "transcript.upsert",
        payload: {
          sessionId: "s1",
          entry: {
            messageId: "m1",
            turnId: "t1",
            role: "system",
            type: "test.note",
            content: "unsafe",
            status: "streaming"
          }
        }
      });
    }
    return {
      kind: "handler_result",
      details: {
        performActionAvailable: false
      }
    };
  });
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.unsafe",
        payload: {}
      },
      runtimeTools(),
      {
        executeAction: async () => ({
          actionType: "transcript.upsert",
          status: "performed"
        })
      }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "handler_result");
    assert.equal(
      (results[0] as { details?: { performActionAvailable?: boolean } }).details?.performActionAvailable,
      false
    );
  });
});

test("enforced trust mode denies undeclared action_request capability", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "action-agent",
      `
export function registerAgentEvents(registry) {
  registry.on("event.action", () => ({
    kind: "action_request",
    actionType: "approval.decide",
    payload: {
      approvalId: "approval-1",
      decision: "accept"
    }
  }));
}
`
    );
    await writeManifest(agentsRoot, "action-agent", {
      name: "@fixture/action-agent",
      version: "1.0.0",
      agentId: "action-agent",
      displayName: "Action Agent",
      capabilities: {
        events: ["event.action"],
        actions: []
      },
      entrypoints: {
        events: "./events.mjs"
      }
    });

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      trustMode: "enforced",
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.action",
        payload: {}
      },
      runtimeTools(),
      {
        executeAction: async () => ({
          actionType: "approval.decide",
          status: "performed"
        })
      }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "action_result");
    assert.equal(results[0]?.status, "forbidden");
    assert.equal((results[0]?.details as { code?: string } | undefined)?.code, "undeclared_capability");
  });
});

test("direct action_result return from handler is invalid", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "legacy-action-agent",
      `
export function registerAgentEvents(registry) {
  registry.on("event.legacy", () => ({
    actionType: "approval.decide",
    status: "performed",
    details: { note: "legacy direct result" }
  }));
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.legacy",
        payload: {}
      },
      runtimeTools()
    );

    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "action_result");
    assert.equal(results[0]?.status, "invalid");
    assert.equal((results[0]?.details as { code?: string } | undefined)?.code, "direct_action_result_disallowed");
  });
});

test("dispatch ordering is deterministic by priority, module name, then registration index", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "zeta",
      `
export function registerAgentEvents(registry) {
  registry.on("event.order", () => ({
    status: "enqueued",
    job: { id: "zeta-1", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 20 });
}
`
    );
    await writeEventsModule(
      agentsRoot,
      "alpha",
      `
export function registerAgentEvents(registry) {
  registry.on("event.order", () => ({
    status: "enqueued",
    job: { id: "alpha-1", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 20 });
  registry.on("event.order", () => ({
    status: "enqueued",
    job: { id: "alpha-2", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 20 });
}
`
    );
    await writeEventsModule(
      agentsRoot,
      "beta",
      `
export function registerAgentEvents(registry) {
  registry.on("event.order", () => ({
    status: "enqueued",
    job: { id: "beta-1", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 10 });
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.order",
        payload: {}
      },
      runtimeTools()
    );

    const jobOrder = results
      .filter((entry) => entry.kind === "enqueue_result")
      .map((entry) => `${entry.moduleName}:${entry.job.id}`);

    assert.deepEqual(jobOrder, ["beta:beta-1", "alpha:alpha-1", "alpha:alpha-2", "zeta:zeta-1"]);
  });
});

test("handler failure is isolated and normalized as handler_error", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "broken",
      `
export function registerAgentEvents(registry) {
  registry.on("event.error", () => {
    throw new Error("boom");
  });
}
`
    );
    await writeEventsModule(
      agentsRoot,
      "healthy",
      `
export function registerAgentEvents(registry) {
  registry.on("event.error", () => ({
    status: "enqueued",
    job: { id: "healthy-1", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    const results = await runtime.emit(
      {
        type: "event.error",
        payload: {}
      },
      runtimeTools()
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.kind, "handler_error");
    assert.equal(results[1]?.kind, "enqueue_result");
    assert.equal(results[1]?.moduleName, "healthy");
  });
});

test("loader isolates malformed modules and continues loading healthy modules", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "malformed",
      `
export const nope = true;
`
    );
    await writeEventsModule(
      agentsRoot,
      "healthy",
      `
export function registerAgentEvents(registry) {
  registry.on("event.loaded", () => ({
    status: "enqueued",
    job: { id: "healthy-loaded", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot,
      logger: createLogger([]),
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      }
    });

    await runtime.load();
    const modules = runtime.listLoadedModules();
    assert.deepEqual(
      modules.map((module) => module.moduleName),
      ["healthy"]
    );

    const results = await runtime.emit(
      {
        type: "event.loaded",
        payload: {}
      },
      runtimeTools()
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.kind, "enqueue_result");
    assert.equal(results[0]?.moduleName, "healthy");
  });
});
