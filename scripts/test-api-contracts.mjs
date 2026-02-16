import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const port = 33000 + Math.floor(Math.random() * 1000);
const host = "127.0.0.1";
const apiBase = `http://${host}:${port}/api`;
const runtimeId = `api-contract-${Date.now()}`;
const dataDir = path.join(root, ".data", runtimeId);
const codexHome = path.join(dataDir, "codex-home");

function makeJsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, body };
}

async function request(pathname, init = {}) {
  const response = await fetch(`${apiBase}${pathname}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return makeJsonResponse(response.status, body);
}

async function waitForHealth(timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await request("/health");
      if (health.status === 200 && health.body?.status === "ok") {
        return;
      }
    } catch {
      // ignore until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for API health on ${apiBase}`);
}

function runNodeScript(scriptPath, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath], {
      cwd: root,
      env: {
        ...process.env,
        ...env
      },
      stdio: "inherit"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`script ${scriptPath} failed with code ${code}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  await mkdir(codexHome, { recursive: true });

  const apiProcess = spawn("pnpm", ["--filter", "@repo/api", "exec", "tsx", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      LOG_LEVEL: "warn"
    },
    stdio: "inherit"
  });

  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;

    if (!apiProcess.killed) {
      apiProcess.kill("SIGTERM");
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));

    if (apiProcess.exitCode === null && !apiProcess.killed) {
      apiProcess.kill("SIGKILL");
    }

    await rm(dataDir, { recursive: true, force: true });
  };

  const onSignal = async () => {
    await cleanup();
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await waitForHealth();

    const capabilities = await request("/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(typeof capabilities.body?.methods, "object");

    const collaborationModes = await request("/collaboration/modes?limit=5");
    assert.ok(
      collaborationModes.status === 200 || collaborationModes.status === 501,
      `unexpected /collaboration/modes status ${collaborationModes.status}`
    );

    const createSession = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(createSession.status, 200);
    const sessionId = createSession.body?.session?.sessionId;
    assert.equal(typeof sessionId, "string");

    const sessionsAfterCreate = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterCreate.status, 200);
    const activeCountAfterCreate = Array.isArray(sessionsAfterCreate.body?.data) ? sessionsAfterCreate.body.data.length : -1;
    assert.ok(activeCountAfterCreate >= 1, "expected at least one active session after create");

    const suggestedReplyWithDraft = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Please improve this sentence." })
    });
    assert.equal(suggestedReplyWithDraft.status, 200);
    assert.equal(typeof suggestedReplyWithDraft.body?.suggestion, "string");
    assert.ok(suggestedReplyWithDraft.body.suggestion.length > 0);

    const suggestedReplyNoContext = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(suggestedReplyNoContext.status, 409);
    assert.equal(suggestedReplyNoContext.body?.status, "no_context");

    const sessionsAfterSuggest = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterSuggest.status, 200);
    const activeCountAfterSuggest = Array.isArray(sessionsAfterSuggest.body?.data) ? sessionsAfterSuggest.body.data.length : -1;
    assert.equal(activeCountAfterSuggest, activeCountAfterCreate, "suggested-reply should not leak helper sessions into session list");

    const invalidRollback = await request(`/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numTurns: 0 })
    });
    assert.equal(invalidRollback.status, 400);
    assert.equal(invalidRollback.body?.code, "invalid_request");

    const invalidToolDecision = await request("/tool-input/not-a-real-id/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "invalid" })
    });
    assert.equal(invalidToolDecision.status, 400);

    const missingToolDecision = await request("/tool-input/not-a-real-id/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "cancel" })
    });
    assert.equal(missingToolDecision.status, 404);

    const invalidAccountCancel = await request("/account/login/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(invalidAccountCancel.status, 400);

    const invalidConfigBatch = await request("/config/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [] })
    });
    assert.equal(invalidConfigBatch.status, 400);

    const invalidSkillsConfig = await request("/skills/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(invalidSkillsConfig.status, 400);

    await runNodeScript(path.join(root, "scripts", "smoke-runtime.mjs"), {
      API_BASE: apiBase,
      SMOKE_TIMEOUT_MS: "180000"
    });

    console.log("API_CONTRACT_OK");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

await main();
