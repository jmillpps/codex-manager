import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentEventsRuntime } from "./agent-events-runtime.js";

async function withTempAgentsRoot(fn: (agentsRoot: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-events-reload-test-"));
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

async function writeManifest(agentsRoot: string, moduleName: string, manifest: Record<string, unknown>): Promise<void> {
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

function createRuntime(agentsRoot: string): AgentEventsRuntime {
  return new AgentEventsRuntime({
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
}

test("reload swaps active snapshot on success", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "alpha",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", () => ({
    status: "enqueued",
    job: { id: "alpha", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const runtime = createRuntime(agentsRoot);
    await runtime.load();
    const before = runtime.snapshotInfo();
    assert.equal(runtime.listLoadedModules().length, 1);

    await writeEventsModule(
      agentsRoot,
      "beta",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", () => ({
    status: "enqueued",
    job: { id: "beta", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const reloaded = await runtime.reload("reload-success");
    assert.equal(reloaded.status, "ok");
    if (reloaded.status === "ok") {
      assert.equal(reloaded.loadedCount, 2);
    }

    const after = runtime.snapshotInfo();
    assert.notEqual(after.snapshotVersion, before.snapshotVersion);
    assert.equal(runtime.listLoadedModules().length, 2);
  });
});

test("failed reload preserves prior snapshot", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "alpha",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", () => ({
    status: "enqueued",
    job: { id: "alpha", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const runtime = createRuntime(agentsRoot);
    await runtime.load();
    const before = runtime.snapshotInfo();
    assert.equal(runtime.listLoadedModules().length, 1);

    await writeManifest(agentsRoot, "bad-extension", {
      name: "@acme/bad-extension",
      version: "1.0.0",
      agentId: "bad",
      displayName: "Bad Extension",
      runtime: {
        coreApiVersionRange: ">=2 <3"
      },
      entrypoints: {
        events: "./events.mjs"
      }
    });
    await writeEventsModule(
      agentsRoot,
      "bad-extension",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", () => ({
    status: "enqueued",
    job: { id: "bad", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`
    );

    const reloaded = await runtime.reload("reload-failure");
    assert.equal(reloaded.status, "error");
    if (reloaded.status === "error") {
      assert.equal(reloaded.code, "reload_failed");
      assert.ok(reloaded.errors.some((entry) => entry.code === "incompatible_runtime"));
    }

    const after = runtime.snapshotInfo();
    assert.equal(after.snapshotVersion, before.snapshotVersion);
    assert.equal(runtime.listLoadedModules().length, 1);
  });
});

test("in-flight emit uses prior snapshot while reload swaps future emits", async () => {
  await withTempAgentsRoot(async (agentsRoot) => {
    await writeEventsModule(
      agentsRoot,
      "alpha",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      status: "enqueued",
      job: { id: "alpha", type: "suggest_request", projectId: "p1", state: "queued" }
    };
  }, { priority: 1 });
}
`
    );

    const runtime = createRuntime(agentsRoot);
    await runtime.load();

    const inFlightEmit = runtime.emit(
      {
        type: "reload.event",
        payload: {}
      },
      runtimeTools()
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeEventsModule(
      agentsRoot,
      "beta",
      `
export function registerAgentEvents(registry) {
  registry.on("reload.event", () => ({
    status: "enqueued",
    job: { id: "beta", type: "suggest_request", projectId: "p1", state: "queued" }
  }), { priority: 2 });
}
`
    );
    const reloadResult = await runtime.reload("reload-boundary");
    assert.equal(reloadResult.status, "ok");

    const priorResults = await inFlightEmit;
    assert.equal(priorResults.filter((entry) => entry.kind === "enqueue_result").length, 1);

    const nextResults = await runtime.emit(
      {
        type: "reload.event",
        payload: {}
      },
      runtimeTools()
    );
    assert.equal(nextResults.filter((entry) => entry.kind === "enqueue_result").length, 2);
  });
});
