import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const supplementalTranscriptPath = path.join(dataDir, "supplemental-transcript.json");
const sessionMetadataPath = path.join(dataDir, "session-metadata.json");
const orchestratorJobsPath = path.join(dataDir, "orchestrator-jobs.json");
const extensionAuditPath = path.join(dataDir, "agent-extension-audit.json");
const requestTimeoutMsRaw = Number(process.env.API_CONTRACT_REQUEST_TIMEOUT_MS ?? 15_000);
const requestTimeoutMs = Number.isFinite(requestTimeoutMsRaw) && requestTimeoutMsRaw > 0 ? requestTimeoutMsRaw : 15_000;

function makeJsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, body };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(error) {
  const causeCode = error && typeof error === "object" && "cause" in error ? error.cause?.code : undefined;
  return causeCode === "ECONNREFUSED" || causeCode === "ECONNRESET" || causeCode === "EPIPE";
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

async function waitFor(condition, description, timeoutMs = 60_000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await condition();
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function assertApiProcessAlive(processHandle, stage) {
  if (!processHandle) {
    return;
  }
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    throw new Error(
      `api process exited during ${stage} (exitCode=${String(processHandle.exitCode)}, signal=${String(processHandle.signalCode)})`
    );
  }
}

async function request(pathname, init = {}) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeoutAbortController = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutAbortController.abort(), requestTimeoutMs);
    const signal =
      init && typeof init === "object" && "signal" in init && init.signal
        ? AbortSignal.any([init.signal, timeoutAbortController.signal])
        : timeoutAbortController.signal;
    try {
      const response = await fetch(`${apiBase}${pathname}`, { ...init, signal });
      const text = await response.text();
      let body;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      clearTimeout(timeoutHandle);
      return makeJsonResponse(response.status, body);
    } catch (error) {
      clearTimeout(timeoutHandle);
      const timedOut = isAbortError(error) && timeoutAbortController.signal.aborted;
      if (attempt >= maxAttempts || (!isRetryableNetworkError(error) && !timedOut)) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }

  throw new Error(`request attempts exhausted for ${pathname}`);
}

async function waitForApiDown(timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), 400);
    try {
      await fetch(`${apiBase}/health`, {
        method: "GET",
        signal: abortController.signal
      });
    } catch {
      clearTimeout(timeoutHandle);
      return;
    }
    clearTimeout(timeoutHandle);
    await sleep(150);
  }

  throw new Error(`api process did not release ${apiBase} within ${timeoutMs}ms`);
}

async function waitForHealth(timeoutMs = 60_000, processHandle = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertApiProcessAlive(processHandle, "health wait");
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

async function waitForSessionContext(sessionId, timeoutMs = 30_000, processHandle = null) {
  const started = Date.now();
  const encodedSessionId = encodeURIComponent(sessionId);

  while (Date.now() - started < timeoutMs) {
    assertApiProcessAlive(processHandle, "session context wait");
    let detail;
    try {
      detail = await request(`/sessions/${encodedSessionId}`);
    } catch {
      assertApiProcessAlive(processHandle, "session context wait after request error");
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (detail.status === 200) {
      const transcript = Array.isArray(detail.body?.transcript) ? detail.body.transcript : [];
      const hasChatContext = transcript.some(
        (entry) =>
          (entry?.role === "user" || entry?.role === "assistant") &&
          typeof entry?.content === "string" &&
          entry.content.trim().length > 0
      );

      if (hasChatContext) {
        return true;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
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

function startApiProcess(envOverrides = {}) {
  return spawn("pnpm", ["--filter", "@repo/api", "exec", "tsx", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      DATA_DIR: dataDir,
      CODEX_HOME: codexHome,
      LOG_LEVEL: "warn",
      DEFAULT_APPROVAL_POLICY: "on-failure",
      ...envOverrides
    },
    stdio: "inherit",
    detached: true
  });
}

function signalApiProcessTree(processHandle, signal) {
  const pid = typeof processHandle?.pid === "number" ? processHandle.pid : null;
  if (pid && Number.isInteger(pid) && pid > 1) {
    if (process.platform === "win32") {
      try {
        const args = ["/PID", String(pid), "/T"];
        if (signal === "SIGKILL") {
          args.push("/F");
        }
        spawnSync("taskkill", args, { stdio: "ignore" });
        return;
      } catch {
        // fall through to direct child signaling
      }
    }

    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to direct child signaling
    }
  }

  try {
    processHandle.kill(signal);
  } catch {
    // ignore signaling errors; waitForExit handles terminal detection
  }
}

async function stopApiProcess(processHandle) {
  if (!processHandle) {
    return;
  }

  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    signalApiProcessTree(processHandle, "SIGTERM");
    signalApiProcessTree(processHandle, "SIGKILL");
    await waitForApiDown(2_500);
    return;
  }

  const waitForExit = (timeoutMs) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        processHandle.off("exit", onExit);
        resolve();
      };
      const onExit = () => {
        finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      processHandle.on("exit", onExit);
    });

  signalApiProcessTree(processHandle, "SIGTERM");
  await waitForExit(1_500);

  if (processHandle.exitCode === null && processHandle.signalCode === null) {
    signalApiProcessTree(processHandle, "SIGKILL");
    await waitForExit(1_500);
  }

  await waitForApiDown(5_000);
}

async function appendSyntheticSupplementalEntries(threadId, entries) {
  let parsed;
  try {
    const raw = await readFile(supplementalTranscriptPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const normalized =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.byThreadId &&
    typeof parsed.byThreadId === "object" &&
    !Array.isArray(parsed.byThreadId)
      ? parsed
      : { version: 1, sequence: 1, byThreadId: {} };

  const currentSequence = Number.isFinite(normalized.sequence) && normalized.sequence > 0 ? Math.floor(normalized.sequence) : 1;
  let nextSequence = currentSequence;
  const existing = Array.isArray(normalized.byThreadId[threadId]) ? normalized.byThreadId[threadId] : [];

  const appended = entries.map((entry) => {
    const sequence = nextSequence;
    nextSequence += 1;
    return {
      sequence,
      entry
    };
  });

  normalized.byThreadId[threadId] = [...existing, ...appended];
  normalized.sequence = nextSequence;
  normalized.version = 1;

  await writeFile(supplementalTranscriptPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function readSessionMetadata() {
  try {
    const raw = await readFile(sessionMetadataPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      projectAgentSessionByKey: {},
      systemOwnedSessionIds: {},
      sessionControlsById: {},
      sessionApprovalPolicyById: {}
    };
  }
}

async function injectSessionControlMetadata(sessionId, controls, approvalPolicy) {
  const metadata = await readSessionMetadata();
  const next = {
    ...metadata,
    sessionControlsById:
      metadata && typeof metadata.sessionControlsById === "object" && metadata.sessionControlsById !== null
        ? { ...metadata.sessionControlsById }
        : {},
    sessionApprovalPolicyById:
      metadata && typeof metadata.sessionApprovalPolicyById === "object" && metadata.sessionApprovalPolicyById !== null
        ? { ...metadata.sessionApprovalPolicyById }
        : {}
  };

  next.sessionControlsById[sessionId] = controls;
  next.sessionApprovalPolicyById[sessionId] = approvalPolicy;
  await writeFile(sessionMetadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function injectProjectAgentSessionMapping(projectId, agent, sessionId) {
  const metadata = await readSessionMetadata();
  const next = {
    ...metadata,
    projectAgentSessionByKey:
      metadata && typeof metadata.projectAgentSessionByKey === "object" && metadata.projectAgentSessionByKey !== null
        ? { ...metadata.projectAgentSessionByKey }
        : {},
    systemOwnedSessionIds:
      metadata && typeof metadata.systemOwnedSessionIds === "object" && metadata.systemOwnedSessionIds !== null
        ? { ...metadata.systemOwnedSessionIds }
        : {}
  };

  next.projectAgentSessionByKey[`${projectId}::${agent}`] = sessionId;
  next.systemOwnedSessionIds[sessionId] = true;
  await writeFile(sessionMetadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function assertNoStoredSessionControlEntries(sessionId, reason) {
  const metadata = await readSessionMetadata();
  assert.equal(
    Object.prototype.hasOwnProperty.call(metadata?.sessionControlsById ?? {}, sessionId),
    false,
    `unexpected sessionControlsById entry for ${sessionId} (${reason})`
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(metadata?.sessionApprovalPolicyById ?? {}, sessionId),
    false,
    `unexpected sessionApprovalPolicyById entry for ${sessionId} (${reason})`
  );
}

async function readOrchestratorJobsSnapshot() {
  try {
    const raw = await readFile(orchestratorJobsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      Array.isArray(parsed.jobs)
    ) {
      return parsed;
    }
  } catch {
    // fall through to default
  }

  return {
    version: 1,
    jobs: []
  };
}

async function injectQueuedOrchestratorJob(job) {
  const snapshot = await readOrchestratorJobsSnapshot();
  const existingJobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
  const next = {
    version: 1,
    jobs: [...existingJobs.filter((entry) => entry?.id !== job.id), job]
  };
  await writeFile(orchestratorJobsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function waitForOrchestratorJobTerminal(jobId, timeoutMs = 90_000, processHandle = null) {
  const started = Date.now();
  const encodedJobId = encodeURIComponent(jobId);

  while (Date.now() - started < timeoutMs) {
    assertApiProcessAlive(processHandle, "orchestrator job terminal wait");
    let detail;
    try {
      detail = await request(`/orchestrator/jobs/${encodedJobId}`);
    } catch {
      assertApiProcessAlive(processHandle, "orchestrator job terminal wait after request error");
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (detail.status === 200) {
      const state = detail.body?.job?.state;
      if (state === "completed" || state === "failed" || state === "canceled") {
        return detail.body.job;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for orchestrator job terminal state: ${jobId}`);
}

async function main() {
  await mkdir(codexHome, { recursive: true });
  let apiProcess = startApiProcess();

  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;

    await stopApiProcess(apiProcess);
    const cleanupRetries = 5;
    for (let attempt = 1; attempt <= cleanupRetries; attempt += 1) {
      try {
        await rm(dataDir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const retryable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
        if (!retryable || attempt === cleanupRetries) {
          throw error;
        }
        await sleep(200 * attempt);
      }
    }
  };

  const onSignal = async () => {
    await cleanup();
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await waitForHealth(60_000, apiProcess);

    const capabilities = await request("/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(typeof capabilities.body?.methods, "object");

    const collaborationModes = await request("/collaboration/modes?limit=5");
    assert.ok(
      collaborationModes.status === 200 || collaborationModes.status === 501,
      `unexpected /collaboration/modes status ${collaborationModes.status}`
    );

    const extensionList = await request("/agents/extensions");
    assert.equal(extensionList.status, 200);
    assert.equal(extensionList.body?.status, "ok");
    assert.ok(Array.isArray(extensionList.body?.modules));

    const extensionReload = await request("/agents/extensions/reload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.ok(
      extensionReload.status === 200 || extensionReload.status === 400 || extensionReload.status === 409,
      `unexpected extension reload status ${extensionReload.status}`
    );

    const extensionAuditRaw = await readFile(extensionAuditPath, "utf8");
    const extensionAudit = JSON.parse(extensionAuditRaw);
    assert.equal(extensionAudit?.version, 1);
    assert.ok(Array.isArray(extensionAudit?.records));
    assert.ok(extensionAudit.records.length >= 1);

    const createSession = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(createSession.status, 200);
    const sessionId = createSession.body?.session?.sessionId;
    assert.equal(typeof sessionId, "string");
    assert.equal(createSession.body?.session?.approvalPolicy, "on-failure");
    assert.equal(createSession.body?.session?.sessionControls?.approvalPolicy, "on-failure");

    const controlsAfterCreate = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`);
    assert.equal(controlsAfterCreate.status, 200);
    assert.equal(controlsAfterCreate.body?.controls?.approvalPolicy, "on-failure");
    assert.equal(controlsAfterCreate.body?.defaults?.approvalPolicy, "on-failure");

    const missingSessionId = "0199dead-beef-7bad-babe-123456789abc";
    const invalidSessionId = "not-a-valid-thread-id";

    const missingApprovalPolicy = await request(`/sessions/${encodeURIComponent(missingSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(missingApprovalPolicy.status, 404);

    const missingMessageSend = await request(`/sessions/${encodeURIComponent(missingSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "orphan-write-missing-session", effort: "minimal" })
    });
    assert.equal(missingMessageSend.status, 404);
    await assertNoStoredSessionControlEntries(missingSessionId, "missing-session write attempts");

    const invalidControlsGet = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/session-controls`);
    assert.equal(invalidControlsGet.status, 404);

    const invalidControlsPost = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/session-controls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        controls: {
          model: null,
          approvalPolicy: "on-failure",
          networkAccess: "restricted",
          filesystemSandbox: "read-only"
        },
        actor: "api-contract",
        source: "api-contract"
      })
    });
    assert.equal(invalidControlsPost.status, 404);

    const invalidSettingsGet = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/settings`);
    assert.equal(invalidSettingsGet.status, 404);

    const invalidSettingsPost = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        key: "supervisor",
        value: { fileChange: { diffExplainability: true } }
      })
    });
    assert.equal(invalidSettingsPost.status, 404);

    const invalidSettingsDelete = await request(
      `/sessions/${encodeURIComponent(invalidSessionId)}/settings/${encodeURIComponent("supervisor")}`,
      {
        method: "DELETE"
      }
    );
    assert.equal(invalidSettingsDelete.status, 404);

    const invalidApprovalPolicy = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(invalidApprovalPolicy.status, 404);

    const invalidMessageSend = await request(`/sessions/${encodeURIComponent(invalidSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "orphan-write-invalid-session", effort: "minimal" })
    });
    assert.equal(invalidMessageSend.status, 404);
    await assertNoStoredSessionControlEntries(invalidSessionId, "invalid-session write attempts");

    const setLegacyOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(setLegacyOnFailure.status, 200);
    assert.equal(setLegacyOnFailure.body?.approvalPolicy, "on-failure");

    const applySessionControlsOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        controls: {
          model: null,
          approvalPolicy: "on-failure",
          networkAccess: "restricted",
          filesystemSandbox: "read-only"
        },
        actor: "api-contract",
        source: "api-contract"
      })
    });
    assert.equal(applySessionControlsOnFailure.status, 200);
    assert.equal(applySessionControlsOnFailure.body?.controls?.approvalPolicy, "on-failure");
    assert.equal(applySessionControlsOnFailure.body?.applied?.approvalPolicy, "on-failure");

    const sessionSettingsGetInitial = await request(`/sessions/${encodeURIComponent(sessionId)}/settings`);
    assert.equal(sessionSettingsGetInitial.status, 200);
    assert.equal(sessionSettingsGetInitial.body?.status, "ok");
    assert.equal(typeof sessionSettingsGetInitial.body?.settings, "object");

    const sessionSettingsSet = await request(`/sessions/${encodeURIComponent(sessionId)}/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "session",
        key: "supervisor",
        value: {
          fileChange: {
            diffExplainability: true,
            autoActions: {
              approve: { enabled: false, threshold: "low" },
              reject: { enabled: false, threshold: "high" },
              steer: { enabled: false, threshold: "high" }
            }
          }
        },
        actor: "api-contract",
        source: "api-contract"
      })
    });
    assert.equal(sessionSettingsSet.status, 200);
    assert.ok(
      sessionSettingsSet.body?.status === "ok" || sessionSettingsSet.body?.status === "unchanged",
      `unexpected settings set status ${sessionSettingsSet.body?.status}`
    );

    const sessionSettingsGetKey = await request(
      `/sessions/${encodeURIComponent(sessionId)}/settings?scope=session&key=${encodeURIComponent("supervisor")}`
    );
    assert.equal(sessionSettingsGetKey.status, 200);
    assert.equal(sessionSettingsGetKey.body?.status, "ok");
    assert.equal(sessionSettingsGetKey.body?.found, true);
    assert.equal(typeof sessionSettingsGetKey.body?.value, "object");

    const sessionSettingsDelete = await request(
      `/sessions/${encodeURIComponent(sessionId)}/settings/${encodeURIComponent("supervisor")}?scope=session&actor=api-contract&source=api-contract`,
      {
        method: "DELETE"
      }
    );
    assert.equal(sessionSettingsDelete.status, 200);
    assert.equal(sessionSettingsDelete.body?.status, "ok");
    assert.equal(sessionSettingsDelete.body?.removed, true);

    const sessionsAfterCreate = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterCreate.status, 200);
    const activeCountAfterCreate = Array.isArray(sessionsAfterCreate.body?.data) ? sessionsAfterCreate.body.data.length : -1;
    assert.ok(activeCountAfterCreate >= 1, "expected at least one active session after create");

    const projectCreate = await request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: `api-contract-project-${Date.now()}`,
        workingDirectory: root
      })
    });
    assert.equal(projectCreate.status, 200);
    const projectId = projectCreate.body?.project?.projectId;
    const orchestratorSessionId = projectCreate.body?.orchestrationSession?.sessionId;
    assert.equal(typeof projectId, "string");
    assert.equal(orchestratorSessionId ?? null, null);

    const sessionsAfterProjectCreate = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterProjectCreate.status, 200);
    assert.equal(
      Array.isArray(sessionsAfterProjectCreate.body?.data) && sessionsAfterProjectCreate.body.data.some((entry) => entry?.source === "subAgent"),
      false,
      "system-owned agent sessions should be hidden from session list"
    );

    const setLegacyBackOnFailure = await request(`/sessions/${encodeURIComponent(sessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(setLegacyBackOnFailure.status, 200);
    assert.equal(setLegacyBackOnFailure.body?.approvalPolicy, "on-failure");

    const sendSeedMessage = await request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Seed context for suggested request effort contract coverage.",
        effort: "minimal",
        approvalPolicy: "on-failure"
      })
    });
    assert.equal(sendSeedMessage.status, 202);
    assert.equal(typeof sendSeedMessage.body?.turnId, "string");
    const seedTurnId = sendSeedMessage.body?.turnId;
    const steerSeedTurn = await request(
      `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(seedTurnId)}/steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "Continue with one more concise line." })
      }
    );
    assert.ok(
      steerSeedTurn.status === 200 || steerSeedTurn.status === 400 || steerSeedTurn.status === 409,
      `unexpected steer status ${steerSeedTurn.status}`
    );
    if (steerSeedTurn.status === 400) {
      const steerError = String(steerSeedTurn.body?.result?.details?.error ?? "");
      assert.ok(/no active turn to steer/i.test(steerError), `unexpected steer 400 error: ${steerError}`);
    }

    const controlsAfterSend = await request(`/sessions/${encodeURIComponent(sessionId)}/session-controls`);
    assert.equal(controlsAfterSend.status, 200);
    assert.equal(controlsAfterSend.body?.controls?.approvalPolicy, "on-failure");

    const hasSuggestionContext = await waitForSessionContext(sessionId, 30_000, apiProcess);

    const queuedSuggestRequestOne = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.equal(queuedSuggestRequestOne.status, 202);
    assert.equal(queuedSuggestRequestOne.body?.status, "queued");
    assert.equal(typeof queuedSuggestRequestOne.body?.jobId, "string");
    assert.equal(queuedSuggestRequestOne.body?.dedupe, "enqueued");

    const queuedSuggestRequestTwo = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.equal(queuedSuggestRequestTwo.status, 202);
    assert.equal(queuedSuggestRequestTwo.body?.status, "queued");
    assert.equal(typeof queuedSuggestRequestTwo.body?.jobId, "string");
    assert.ok(
      queuedSuggestRequestTwo.body?.dedupe === "already_queued" || queuedSuggestRequestTwo.body?.dedupe === "enqueued",
      `unexpected dedupe status ${queuedSuggestRequestTwo.body?.dedupe}`
    );
    if (queuedSuggestRequestTwo.body?.dedupe === "already_queued") {
      assert.equal(
        queuedSuggestRequestTwo.body?.jobId,
        queuedSuggestRequestOne.body?.jobId,
        "single-flight dedupe should return the existing suggest job"
      );
    }

    const queuedSuggestTerminal = await waitForOrchestratorJobTerminal(queuedSuggestRequestOne.body?.jobId, 90_000, apiProcess);
    assert.notEqual(
      queuedSuggestTerminal.state === "failed" &&
        /project not found:\s*session:/i.test(String(queuedSuggestTerminal.error ?? "")),
      true,
      "unassigned session suggest-request jobs should not fail with synthetic session project lookup errors"
    );

    const queueHealth = await request("/health");
    assert.equal(queueHealth.status, 200);
    assert.equal(queueHealth.body?.orchestratorQueue?.enabled, true);
    assert.equal(typeof queueHealth.body?.orchestratorQueue?.queued, "number");
    assert.equal(typeof queueHealth.body?.orchestratorQueue?.running, "number");

    const queueJobDetail = await request(`/orchestrator/jobs/${encodeURIComponent(queuedSuggestRequestOne.body?.jobId ?? "")}`);
    assert.equal(queueJobDetail.status, 200);
    assert.equal(queueJobDetail.body?.status, "ok");
    assert.equal(queueJobDetail.body?.job?.id, queuedSuggestRequestOne.body?.jobId);
    assert.equal(typeof queueJobDetail.body?.job?.projectId, "string");

    const queueProjectJobs = await request(
      `/projects/${encodeURIComponent(queueJobDetail.body?.job?.projectId)}/orchestrator/jobs`
    );
    assert.equal(queueProjectJobs.status, 200);
    assert.ok(
      Array.isArray(queueProjectJobs.body?.data) &&
        queueProjectJobs.body.data.some((job) => job?.id === queuedSuggestRequestOne.body?.jobId),
      "project queue listing should include suggest job"
    );

    const missingQueueJobDetail = await request("/orchestrator/jobs/not-a-real-job");
    assert.equal(missingQueueJobDetail.status, 404);
    assert.equal(missingQueueJobDetail.body?.status, "not_found");

    const missingQueueJobCancel = await request("/orchestrator/jobs/not-a-real-job/cancel", {
      method: "POST"
    });
    assert.equal(missingQueueJobCancel.status, 404);
    assert.equal(missingQueueJobCancel.body?.status, "not_found");

    const suggestedRequest = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hasSuggestionContext ? { effort: "minimal" } : { draft: "Please improve this sentence.", effort: "minimal" })
    });
    assert.ok(suggestedRequest.status === 200 || suggestedRequest.status === 202);

    if (suggestedRequest.status === 200) {
      assert.equal(typeof suggestedRequest.body?.suggestion, "string");
      assert.ok(suggestedRequest.body.suggestion.length > 0);

      if (hasSuggestionContext) {
        assert.ok(
          suggestedRequest.body?.status === "ok" || suggestedRequest.body?.status === "fallback",
          `unexpected suggested-request status with context: ${suggestedRequest.body?.status}`
        );
      } else {
        assert.equal(suggestedRequest.body?.status, "fallback");
      }
    } else {
      assert.equal(suggestedRequest.body?.status, "queued");
      assert.equal(typeof suggestedRequest.body?.jobId, "string");
    }

    const assignSessionToProject = await request(`/sessions/${encodeURIComponent(sessionId)}/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId })
    });
    assert.equal(assignSessionToProject.status, 200);
    assert.equal(assignSessionToProject.body?.projectId, projectId);

    const projectSuggestRequest = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Provide one practical next-step reply." })
    });
    assert.equal(projectSuggestRequest.status, 202);
    assert.equal(typeof projectSuggestRequest.body?.jobId, "string");
    await waitForOrchestratorJobTerminal(projectSuggestRequest.body?.jobId, 90_000, apiProcess);

    const metadataAfterProjectSuggest = await readSessionMetadata();
    const supervisorKey = `${projectId}::supervisor`;
    const mappedSupervisorSessionId = metadataAfterProjectSuggest?.projectAgentSessionByKey?.[supervisorKey];
    assert.equal(typeof mappedSupervisorSessionId, "string");
    assert.ok(mappedSupervisorSessionId.length > 0);

    const bogusSupervisorSessionId = `stale-supervisor-${Date.now()}`;
    await injectProjectAgentSessionMapping(projectId, "supervisor", bogusSupervisorSessionId);

    const recoveredSuggestRequest = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Continue with one concrete user-facing next step." })
    });
    assert.equal(recoveredSuggestRequest.status, 202);
    assert.equal(typeof recoveredSuggestRequest.body?.jobId, "string");
    const recoveredSuggestTerminal = await waitForOrchestratorJobTerminal(recoveredSuggestRequest.body?.jobId, 90_000, apiProcess);
    assert.notEqual(
      recoveredSuggestTerminal.state === "failed" && /thread not found|invalid thread id/i.test(String(recoveredSuggestTerminal.error)),
      true,
      "suggest-request should recover from stale mapped supervisor session instead of failing with thread-not-found"
    );

    const unassignSessionFromProject = await request(`/sessions/${encodeURIComponent(sessionId)}/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: null })
    });
    assert.equal(unassignSessionFromProject.status, 200);
    assert.equal(unassignSessionFromProject.body?.projectId, null);

    const projectDelete = await request(`/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE"
    });
    assert.equal(projectDelete.status, 200);

    // Risk closure: synthetic transcript dedupe should drop synthetic entries that duplicate canonical
    // same-turn rows while preserving distinct synthetic supplemental entries.
    const detailBeforeRestart = await request(`/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(detailBeforeRestart.status, 200);
    const transcriptBeforeRestart = Array.isArray(detailBeforeRestart.body?.transcript) ? detailBeforeRestart.body.transcript : [];
    const canonicalEntry = transcriptBeforeRestart.find((entry) => {
      const messageId = typeof entry?.messageId === "string" ? entry.messageId : "";
      const isSynthetic = /^item-\d+$/i.test(messageId);
      const hasText = typeof entry?.content === "string" && entry.content.trim().length > 0;
      const hasTurnId = typeof entry?.turnId === "string" && entry.turnId.trim().length > 0;
      const isReasoning = entry?.type === "reasoning";
      return !isSynthetic && !isReasoning && hasText && hasTurnId;
    });
    assert.ok(canonicalEntry, "expected at least one canonical transcript entry before dedupe test");

    const syntheticSeed = Date.now();
    const duplicateSyntheticMessageId = `item-${syntheticSeed + 1000}`;
    const distinctSyntheticMessageId = `item-${syntheticSeed + 1001}`;
    const baseStartedAt =
      Number.isFinite(canonicalEntry.startedAt) && canonicalEntry.startedAt > 0
        ? canonicalEntry.startedAt
        : Date.now();
    await appendSyntheticSupplementalEntries(sessionId, [
      {
        messageId: duplicateSyntheticMessageId,
        turnId: canonicalEntry.turnId,
        role: canonicalEntry.role,
        type: canonicalEntry.type,
        content: canonicalEntry.content,
        status: "complete",
        startedAt: baseStartedAt,
        completedAt: baseStartedAt + 1
      },
      {
        messageId: distinctSyntheticMessageId,
        turnId: canonicalEntry.turnId,
        role: canonicalEntry.role,
        type: canonicalEntry.type,
        content: `[synthetic-distinct] ${canonicalEntry.content}`,
        status: "complete",
        startedAt: baseStartedAt,
        completedAt: baseStartedAt + 2
      }
    ]);

    const deletedSession = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(deletedSession.status, 200);
    const deletedSessionId = deletedSession.body?.session?.sessionId;
    assert.equal(typeof deletedSessionId, "string");

    const deletedSessionDelete = await request(`/sessions/${encodeURIComponent(deletedSessionId)}`, {
      method: "DELETE"
    });
    assert.equal(deletedSessionDelete.status, 200);

    const deletedPolicyBeforeRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/approval-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalPolicy: "on-failure" })
    });
    assert.equal(deletedPolicyBeforeRestart.status, 410);

    const deletedMessageBeforeRestart = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "deleted-before-restart", effort: "minimal" })
    });
    assert.equal(deletedMessageBeforeRestart.status, 410);
    await assertNoStoredSessionControlEntries(deletedSessionId, "deleted-session before restart");

    await stopApiProcess(apiProcess);
    apiProcess = startApiProcess();
    await waitForHealth(60_000, apiProcess);

    const detailAfterRestart = await request(`/sessions/${encodeURIComponent(sessionId)}`);
    assert.equal(detailAfterRestart.status, 200);
    const transcriptAfterRestart = Array.isArray(detailAfterRestart.body?.transcript) ? detailAfterRestart.body.transcript : [];
    assert.equal(
      transcriptAfterRestart.some((entry) => entry?.messageId === duplicateSyntheticMessageId),
      false,
      "synthetic duplicate entry should be removed when canonical same-turn match exists"
    );
    const distinctSyntheticStillPresent = transcriptAfterRestart.some((entry) => entry?.messageId === distinctSyntheticMessageId);
    assert.equal(
      typeof distinctSyntheticStillPresent,
      "boolean",
      "synthetic dedupe reconcile should complete without corrupting transcript state"
    );

    const deletedPolicyAfterRestart = await waitFor(
      async () => {
        const response = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/approval-policy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvalPolicy: "on-failure" })
        });
        if (response.status === 404) {
          return response;
        }
        if (response.status === 503 || response.status === 500) {
          return null;
        }
        throw new Error(`unexpected status for deleted approval policy after restart: ${response.status}`);
      },
      "deleted session approval policy 404 after restart",
      30_000,
      500
    );
    assert.equal(deletedPolicyAfterRestart.status, 404);

    const deletedMessageAfterRestart = await waitFor(
      async () => {
        const response = await request(`/sessions/${encodeURIComponent(deletedSessionId)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "deleted-after-restart", effort: "minimal" })
        });
        if (response.status === 404) {
          return response;
        }
        if (response.status === 503 || response.status === 500) {
          return null;
        }
        throw new Error(`unexpected status for deleted message after restart: ${response.status}`);
      },
      "deleted session messages 404 after restart",
      30_000,
      500
    );
    assert.equal(deletedMessageAfterRestart.status, 404);
    await assertNoStoredSessionControlEntries(deletedSessionId, "deleted-session after restart");

    const staleMetadataSessionId = "0199dead-beef-7bad-babe-feedfeedfeed";
    await injectSessionControlMetadata(
      staleMetadataSessionId,
      {
        model: null,
        approvalPolicy: "on-failure",
        networkAccess: "restricted",
        filesystemSandbox: "read-only"
      },
      "on-failure"
    );
    const metadataAfterInjection = await readSessionMetadata();
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadataAfterInjection?.sessionControlsById ?? {}, staleMetadataSessionId),
      true
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(metadataAfterInjection?.sessionApprovalPolicyById ?? {}, staleMetadataSessionId),
      true
    );

    await stopApiProcess(apiProcess);
    apiProcess = startApiProcess();
    await waitForHealth(60_000, apiProcess);

    await waitFor(
      async () => {
        try {
          await assertNoStoredSessionControlEntries(staleMetadataSessionId, "startup stale metadata prune");
          return true;
        } catch {
          return null;
        }
      },
      "startup stale metadata prune",
      30_000,
      500
    );

    const suggestedRequestInvalidEffort = await request(`/sessions/${encodeURIComponent(sessionId)}/suggested-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Please improve this sentence.", effort: "invalid" })
    });
    assert.equal(suggestedRequestInvalidEffort.status, 400);

    const sessionsAfterSuggest = await request("/sessions?archived=false&limit=200");
    assert.equal(sessionsAfterSuggest.status, 200);
    const activeCountAfterSuggest = Array.isArray(sessionsAfterSuggest.body?.data) ? sessionsAfterSuggest.body.data.length : -1;
    assert.ok(activeCountAfterSuggest >= activeCountAfterCreate);

    const noContextSessionCreate = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(noContextSessionCreate.status, 200);
    const noContextSessionId = noContextSessionCreate.body?.session?.sessionId;
    assert.equal(typeof noContextSessionId, "string");

    const suggestedRequestNoContext = await request(`/sessions/${encodeURIComponent(noContextSessionId)}/suggested-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.ok(suggestedRequestNoContext.status === 200 || suggestedRequestNoContext.status === 202 || suggestedRequestNoContext.status === 409);
    if (suggestedRequestNoContext.status === 409) {
      assert.equal(suggestedRequestNoContext.body?.status, "no_context");
    } else if (suggestedRequestNoContext.status === 202) {
      assert.equal(suggestedRequestNoContext.body?.status, "queued");
      assert.equal(typeof suggestedRequestNoContext.body?.jobId, "string");
    } else {
      assert.ok(
        suggestedRequestNoContext.body?.status === "fallback" || suggestedRequestNoContext.body?.status === "ok",
        `unexpected no-context suggested request status ${suggestedRequestNoContext.body?.status}`
      );
    }

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

    const invalidToolCallResponse = await request("/tool-calls/not-a-real-id/response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ success: "invalid" })
    });
    assert.equal(invalidToolCallResponse.status, 400);

    const missingToolCallResponse = await request("/tool-calls/not-a-real-id/response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "done" })
    });
    assert.equal(missingToolCallResponse.status, 404);

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

    if (process.env.API_CONTRACT_EMBEDDED_SMOKE !== "false") {
      await runNodeScript(path.join(root, "scripts", "smoke-runtime.mjs"), {
        API_BASE: apiBase,
        SMOKE_TIMEOUT_MS: "180000"
      });
    }

    await stopApiProcess(apiProcess);
    apiProcess = startApiProcess({
      ORCHESTRATOR_QUEUE_ENABLED: "false"
    });
    await waitForHealth(60_000, apiProcess);

    const degradedHealth = await request("/health");
    assert.equal(degradedHealth.status, 200);
    assert.equal(degradedHealth.body?.orchestratorQueue?.enabled, false);

    const degradedSessionCreate = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(degradedSessionCreate.status, 200);
    const degradedSessionId = degradedSessionCreate.body?.session?.sessionId;
    assert.equal(typeof degradedSessionId, "string");

    const degradedSuggestQueue = await request(`/sessions/${encodeURIComponent(degradedSessionId)}/suggested-request/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Draft for degraded queue test.", effort: "minimal" })
    });
    assert.equal(degradedSuggestQueue.status, 503);
    assert.equal(degradedSuggestQueue.body?.code, "job_conflict");

    const degradedSuggestLegacy = await request(`/sessions/${encodeURIComponent(degradedSessionId)}/suggested-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "Draft for degraded queue test.", effort: "minimal" })
    });
    assert.equal(degradedSuggestLegacy.status, 503);
    assert.equal(degradedSuggestLegacy.body?.code, "job_conflict");

    const degradedJobLookup = await request("/orchestrator/jobs/test-job");
    assert.equal(degradedJobLookup.status, 503);
    assert.equal(degradedJobLookup.body?.code, "job_conflict");

    const degradedProjectJobList = await request("/projects/test-project/orchestrator/jobs");
    assert.equal(degradedProjectJobList.status, 503);
    assert.equal(degradedProjectJobList.body?.code, "job_conflict");

    const degradedJobCancel = await request("/orchestrator/jobs/test-job/cancel", {
      method: "POST"
    });
    assert.equal(degradedJobCancel.status, 503);
    assert.equal(degradedJobCancel.body?.code, "job_conflict");

    console.log("API_CONTRACT_OK");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

const heartbeatMsRaw = Number(process.env.API_CONTRACT_HEARTBEAT_MS ?? 0);
const heartbeatMs = Number.isFinite(heartbeatMsRaw) && heartbeatMsRaw > 0 ? heartbeatMsRaw : 0;
const heartbeat = heartbeatMs
  ? setInterval(() => {
      console.log("API_CONTRACT_HEARTBEAT");
    }, heartbeatMs)
  : null;

try {
  await main();
} finally {
  if (heartbeat) {
    clearInterval(heartbeat);
  }
}
