import assert from "node:assert/strict";
import test from "node:test";
import { runAgentConformance } from "./agent-conformance.js";

test("portable extension conformance passes across codex and fixture runtime profiles", async () => {
  const report = await runAgentConformance();
  assert.equal(report.portableExtension, true);
  assert.equal(report.profiles.length, 2);
  assert.ok(report.profiles.every((profile) => profile.status === "passed"));
  assert.ok(report.profiles.every((profile) => profile.enqueueStatus === "enqueued"));
  assert.ok(report.profiles.every((profile) => profile.enqueueJobType === "suggest_request"));
});
