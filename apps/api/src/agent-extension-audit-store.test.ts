import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import test from "node:test";
import { AgentExtensionAuditStore, type AgentExtensionReloadAuditRecord } from "./agent-extension-audit-store.js";

function buildRecord(reloadId: string): AgentExtensionReloadAuditRecord {
  return {
    reloadId,
    recordedAt: new Date().toISOString(),
    actorRole: "admin",
    actorId: "test-actor",
    requestOrigin: {
      ip: "127.0.0.1",
      userAgent: "test-agent"
    },
    result: "success",
    snapshotBefore: "before-snapshot",
    snapshotAfter: "after-snapshot",
    trustMode: "warn",
    errorSummary: null,
    impactedExtensions: ["agents/supervisor"]
  };
}

test("AgentExtensionAuditStore append serializes concurrent writes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-extension-audit-store-"));
  const store = new AgentExtensionAuditStore({
    dataDir,
    logger: {
      warn: () => {
        // no-op in tests
      }
    }
  });

  const first = buildRecord("reload-1");
  const second = buildRecord("reload-2");

  await Promise.all([store.append(first), store.append(second)]);

  const records = await store.list();
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((entry) => entry.reloadId).sort(),
    ["reload-1", "reload-2"]
  );

  const rawFile = await readFile(store.path, "utf8");
  const parsed = JSON.parse(rawFile) as { version?: number; records?: Array<{ reloadId?: string }> };
  assert.equal(parsed.version, 1);
  assert.equal(Array.isArray(parsed.records), true);
  assert.deepEqual(
    (parsed.records ?? []).map((entry) => entry.reloadId).sort(),
    ["reload-1", "reload-2"]
  );
});
