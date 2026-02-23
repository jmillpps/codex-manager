import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function run(command: string, args: Array<string>, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "ignore"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

test("conformance script emits portable-extension artifact", async () => {
  const repoRoot = path.resolve(process.cwd(), "..", "..");
  const artifactPath = path.join(repoRoot, ".data", "agent-conformance-report.json");

  await run("node", ["scripts/run-agent-conformance.mjs"], repoRoot);

  const raw = await readFile(artifactPath, "utf8");
  const parsed = JSON.parse(raw) as {
    generatedAt?: string;
    coreVersion?: number;
    profiles?: Array<{ profileId?: string; status?: string }>;
    portableExtension?: boolean;
  };

  assert.equal(typeof parsed.generatedAt, "string");
  assert.equal(parsed.coreVersion, 1);
  assert.equal(Array.isArray(parsed.profiles), true);
  assert.equal(parsed.profiles?.length, 2);
  assert.ok(parsed.profiles?.some((entry) => entry.profileId === "codex-manager"));
  assert.ok(parsed.profiles?.some((entry) => entry.profileId === "fixture-profile"));
  assert.ok(parsed.profiles?.every((entry) => entry.status === "passed"));
  assert.equal(parsed.portableExtension, true);
});
