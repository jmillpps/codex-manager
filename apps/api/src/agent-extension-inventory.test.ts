import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateCompatibility, readExtensionManifest, resolveEventsEntrypoint } from "./agent-extension-inventory.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-inventory-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("manifest parsing and entrypoint resolution works for extension roots", async () => {
  await withTempDir(async (root) => {
    const extensionRoot = path.join(root, "sample-extension");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(
      path.join(extensionRoot, "extension.manifest.json"),
      JSON.stringify(
        {
          name: "@acme/sample-agent",
          version: "1.2.0",
          agentId: "sample",
          displayName: "Sample Agent",
          runtime: {
            coreApiVersion: 1,
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
    await writeFile(path.join(extensionRoot, "events.mjs"), "export function registerAgentEvents() {}\n", "utf8");

    const manifestRead = await readExtensionManifest(extensionRoot);
    assert.ok(manifestRead.manifestPath?.endsWith("extension.manifest.json"));
    assert.equal(manifestRead.manifest?.name, "@acme/sample-agent");
    assert.equal(manifestRead.manifest?.agentId, "sample");

    const entrypoint = resolveEventsEntrypoint(extensionRoot, manifestRead.manifest);
    assert.ok(entrypoint?.endsWith("events.mjs"));
  });
});

test("compatibility checks enforce core/profile ranges", () => {
  const compatible = evaluateCompatibility(
    {
      name: "@acme/sample-agent",
      version: "1.0.0",
      agentId: "sample",
      displayName: "Sample Agent",
      runtime: {
        coreApiVersion: 1,
        coreApiVersionRange: ">=1 <2",
        profiles: [
          {
            name: "codex-manager",
            versionRange: ">=1 <2"
          }
        ]
      }
    },
    {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.0.0"
    }
  );
  assert.equal(compatible.compatible, true);

  const incompatible = evaluateCompatibility(
    {
      name: "@acme/sample-agent",
      version: "1.0.0",
      agentId: "sample",
      displayName: "Sample Agent",
      runtime: {
        coreApiVersionRange: ">=2 <3",
        profiles: [
          {
            name: "other-profile",
            versionRange: ">=1 <2"
          }
        ]
      }
    },
    {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.0.0"
    }
  );
  assert.equal(incompatible.compatible, false);
  assert.ok(incompatible.reasons.length >= 1);

  const semverRangeMismatch = evaluateCompatibility(
    {
      name: "@acme/sample-agent",
      version: "1.0.0",
      agentId: "sample",
      displayName: "Sample Agent",
      runtime: {
        profiles: [
          {
            name: "codex-manager",
            versionRange: ">=1.5 <2.0"
          }
        ]
      }
    },
    {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.1.0"
    }
  );
  assert.equal(semverRangeMismatch.compatible, false);
  assert.ok(semverRangeMismatch.reasons.some((reason) => reason.includes("versionRange")));

  const shorthandSemverRangeMismatch = evaluateCompatibility(
    {
      name: "@acme/sample-agent",
      version: "1.0.0",
      agentId: "sample",
      displayName: "Sample Agent",
      runtime: {
        profiles: [
          {
            name: "codex-manager",
            versionRange: ">=1.5 <2.0"
          }
        ]
      }
    },
    {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.1"
    }
  );
  assert.equal(shorthandSemverRangeMismatch.compatible, false);
  assert.ok(shorthandSemverRangeMismatch.reasons.some((reason) => reason.includes("versionRange")));

  const semverRangeMatch = evaluateCompatibility(
    {
      name: "@acme/sample-agent",
      version: "1.0.0",
      agentId: "sample",
      displayName: "Sample Agent",
      runtime: {
        profiles: [
          {
            name: "codex-manager",
            versionRange: ">=1.5 <2.0"
          }
        ]
      }
    },
    {
      coreVersion: 1,
      runtimeProfileId: "codex-manager",
      runtimeProfileVersion: "1.6.2"
    }
  );
  assert.equal(semverRangeMatch.compatible, true);
});
