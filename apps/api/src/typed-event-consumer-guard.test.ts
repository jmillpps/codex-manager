import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function readApiSource(file: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), "src", file), "utf8");
}

test("active runtime event consumers avoid unknown-shape emit parsing", async () => {
  const indexSource = await readApiSource("index.ts");
  const runtimeSource = await readApiSource("agent-events-runtime.ts");

  assert.equal(indexSource.includes("Array<unknown>"), false);
  assert.equal(runtimeSource.includes("Array<unknown>"), false);
  assert.equal(indexSource.includes("firstEnqueueResultFromAgentEvent"), false);

  assert.ok(indexSource.includes("selectEnqueueResultFromAgentEvent"));
  assert.ok(runtimeSource.includes("AgentEventEmitResult"));
});
