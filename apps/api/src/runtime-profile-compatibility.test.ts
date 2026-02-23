import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentEventsRuntime } from "./agent-events-runtime.js";

const portableFixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../test-fixtures/extensions/portable-suggest-agent"
);

function runtimeLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

test("runtime profile compatibility accepts matching profile and rejects incompatible profile", async () => {
  const compatibleRuntime = new AgentEventsRuntime({
    agentsRoot: path.join(portableFixturePath, "__none__"),
    logger: runtimeLogger(),
    trustMode: "enforced",
    runtimeCompatibility: {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.0.0"
    },
    extensionSources: [
      {
        type: "installed_package",
        path: portableFixturePath
      }
    ]
  });

  const compatibleReload = await compatibleRuntime.reload("compat-ok");
  assert.equal(compatibleReload.status, "ok");
  assert.equal(compatibleRuntime.listLoadedModules().length, 1);

  const incompatibleRuntime = new AgentEventsRuntime({
    agentsRoot: path.join(portableFixturePath, "__none__"),
    logger: runtimeLogger(),
    trustMode: "enforced",
    runtimeCompatibility: {
      coreVersion: 1,
      runtimeProfileId: "unknown-profile",
      runtimeProfileVersion: "1.0.0"
    },
    extensionSources: [
      {
        type: "installed_package",
        path: portableFixturePath
      }
    ]
  });

  const incompatibleReload = await incompatibleRuntime.reload("compat-fail");
  assert.equal(incompatibleReload.status, "error");
  if (incompatibleReload.status === "error") {
    assert.equal(incompatibleReload.code, "reload_failed");
    assert.ok(incompatibleReload.errors.some((entry) => entry.code === "incompatible_runtime"));
  }
});

test("external extension sources report deterministic origin metadata", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "runtime-profile-origin-test-"));
  try {
    const configuredRoot = path.join(tempRoot, "configured-root");
    const configuredExtension = path.join(configuredRoot, "configured-extension");
    await mkdir(configuredExtension, { recursive: true });
    await writeFile(
      path.join(configuredExtension, "extension.manifest.json"),
      JSON.stringify(
        {
          name: "@fixture/configured-extension",
          version: "1.0.0",
          agentId: "configured-extension",
          displayName: "Configured Extension",
          runtime: {
            coreApiVersionRange: ">=1 <2",
            profiles: [
              {
                name: "codex-manager",
                versionRange: ">=1 <2"
              }
            ]
          },
          entrypoints: {
            events: "./events.mjs"
          },
          capabilities: {
            events: ["suggest_request.requested"],
            actions: ["queue.enqueue"]
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(configuredExtension, "events.mjs"),
      `
export function registerAgentEvents(registry) {
  registry.on("suggest_request.requested", () => ({
    status: "enqueued",
    job: { id: "configured-job", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`,
      "utf8"
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot: path.join(tempRoot, "__none__"),
      logger: runtimeLogger(),
      trustMode: "enforced",
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      },
      extensionSources: [
        {
          type: "configured_root",
          path: configuredRoot
        },
        {
          type: "installed_package",
          path: portableFixturePath
        }
      ]
    });

    await runtime.load();
    const modules = runtime.listLoadedModules();
    assert.ok(modules.some((module) => module.origin.type === "configured_root"));
    assert.ok(modules.some((module) => module.origin.type === "installed_package"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("source precedence prefers repo_local origin for duplicate extension roots", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "runtime-profile-precedence-test-"));
  try {
    const extensionRoot = path.join(tempRoot, "portable-extension");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      path.join(extensionRoot, "extension.manifest.json"),
      JSON.stringify(
        {
          name: "@fixture/portable-extension",
          version: "1.0.0",
          agentId: "portable-extension",
          displayName: "Portable Extension",
          runtime: {
            coreApiVersionRange: ">=1 <2",
            profiles: [
              {
                name: "codex-manager",
                versionRange: ">=1 <2"
              }
            ]
          },
          entrypoints: {
            events: "./events.mjs"
          },
          capabilities: {
            events: ["suggest_request.requested"],
            actions: ["queue.enqueue"]
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(extensionRoot, "events.mjs"),
      `
export function registerAgentEvents(registry) {
  registry.on("suggest_request.requested", () => ({
    status: "enqueued",
    job: { id: "portable-job", type: "suggest_request", projectId: "p1", state: "queued" }
  }));
}
`,
      "utf8"
    );

    const runtime = new AgentEventsRuntime({
      agentsRoot: extensionRoot,
      logger: runtimeLogger(),
      trustMode: "enforced",
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      },
      extensionSources: [
        {
          type: "configured_root",
          path: extensionRoot
        },
        {
          type: "installed_package",
          path: extensionRoot
        }
      ]
    });

    await runtime.load();
    const modules = runtime.listLoadedModules();
    assert.equal(modules.length, 1);
    assert.equal(modules[0]?.origin.type, "repo_local");
    assert.equal(path.resolve(modules[0]?.origin.path ?? ""), path.resolve(extensionRoot));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("non-directory extension source roots are skipped without crashing runtime load", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "runtime-profile-source-file-test-"));
  try {
    const invalidSourceFile = path.join(tempRoot, "not-a-directory.txt");
    await writeFile(invalidSourceFile, "invalid source root", "utf8");

    const runtime = new AgentEventsRuntime({
      agentsRoot: path.join(tempRoot, "__none__"),
      logger: runtimeLogger(),
      trustMode: "enforced",
      runtimeCompatibility: {
        coreVersion: 1,
        runtimeProfileId: "codex-manager",
        runtimeProfileVersion: "1.0.0"
      },
      extensionSources: [
        {
          type: "configured_root",
          path: invalidSourceFile
        }
      ]
    });

    await runtime.load();
    assert.equal(runtime.listLoadedModules().length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
