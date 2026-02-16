import assert from "node:assert/strict";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001/api";
const WS_BASE = API_BASE.replace(/^http/, "ws");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

const permissiveStatuses = [200, 202, 400, 401, 403, 404, 405, 409, 410, 422, 429, 501];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, { method = "GET", body, headers = {} } = {}, expected = [200]) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!expected.includes(response.status)) {
    throw new Error(
      `Unexpected status for ${method} ${path}: ${response.status}\nExpected: ${expected.join(", ")}\nBody: ${text}`
    );
  }

  return { status: response.status, json, text };
}

async function waitFor(condition, description, timeoutMs = TIMEOUT_MS, intervalMs = 1_500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await condition();
    if (result) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function openSessionSocket(sessionId) {
  const wsUrl = `${WS_BASE}/stream?threadId=${encodeURIComponent(sessionId)}`;
  const ws = new WebSocket(wsUrl);

  const events = [];
  let ready = false;

  ws.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(String(event.data));
      events.push(parsed);
      if (parsed?.type === "ready") {
        ready = true;
      }
    } catch {
      // ignore malformed frames for smoke purposes
    }
  });

  ws.addEventListener("error", (event) => {
    console.error("WebSocket error event", event);
  });

  await waitFor(() => ready, "websocket ready event", 20_000, 100);

  return {
    ws,
    events,
    close: () => ws.close()
  };
}

async function main() {
  const createdSessionIds = [];
  const createdProjectIds = [];
  let socket;

  try {
    const health = await api("/health", {}, [200]);
    assert.equal(health.status, 200);
    assert.equal(health.json?.status, "ok");

    await api("/capabilities", {}, [200]);
    await api("/features/experimental", {}, [200, 501]);
    await api("/collaboration/modes", {}, [200, 501]);
    await api("/apps", {}, [200, 501]);
    await api("/skills", {}, [200, 501]);
    // Remote skills may proxy to external services that can return transient 5xx.
    await api("/skills/remote", {}, [200, 500, 501]);
    await api("/mcp/reload", { method: "POST", body: {} }, [200, 501]);
    await api("/account", {}, [200, 401, 501]);
    await api("/account/rate-limits", {}, [200, 401, 501]);
    await api("/config", {}, [200, 501]);
    await api("/config/requirements", {}, [200, 501]);
    await api("/models", {}, [200, 501]);
    await api("/mcp/servers", {}, [200, 501]);

    const projectName = `Smoke Project ${Date.now()}`;
    const createProject = await api("/projects", { method: "POST", body: { name: projectName } }, [200]);
    const projectId = createProject.json?.project?.projectId;
    assert.equal(typeof projectId, "string");
    createdProjectIds.push(projectId);

    const createSession = await api("/sessions", { method: "POST", body: {} }, [200]);
    const sessionId = createSession.json?.session?.sessionId;
    assert.equal(typeof sessionId, "string");
    createdSessionIds.push(sessionId);

    socket = await openSessionSocket(sessionId);

    await api(`/sessions/${encodeURIComponent(sessionId)}/project`, {
      method: "POST",
      body: { projectId }
    }, [200]);

    await api(`/sessions/${encodeURIComponent(sessionId)}/tool-input`, {}, [200]);

    const cannotDeleteProject = await api(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }, [409]);
    assert.equal(cannotDeleteProject.json?.status, "project_not_empty");

    const sendMessage = await api(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: { text: "Reply with exactly OK" } },
      [202, 401]
    );

    let turnId = null;
    if (sendMessage.status === 202) {
      turnId = sendMessage.json?.turnId ?? null;

      await waitFor(
        async () => {
          const details = await api(`/sessions/${encodeURIComponent(sessionId)}`, {}, [200]);
          const transcript = Array.isArray(details.json?.transcript) ? details.json.transcript : [];
          const assistantComplete = transcript.some((entry) => entry.role === "assistant" && entry.status === "complete");
          const assistantError = transcript.some((entry) => entry.role === "assistant" && entry.status === "error");
          return assistantComplete || assistantError;
        },
        "assistant turn completion in transcript",
        180_000,
        2_000
      );

      await waitFor(
        () => socket.events.some((event) => event?.type === "notification" || event?.type === "approval"),
        "stream events after turn start",
        30_000,
        250
      );

      await api(`/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: {} }, permissiveStatuses);
      await api(`/sessions/${encodeURIComponent(sessionId)}/compact`, { method: "POST", body: {} }, permissiveStatuses);
      await api(`/sessions/${encodeURIComponent(sessionId)}/rollback`, { method: "POST", body: {} }, permissiveStatuses);
      await api(`/sessions/${encodeURIComponent(sessionId)}/background-terminals/clean`, { method: "POST", body: {} }, permissiveStatuses);
      await api(`/sessions/${encodeURIComponent(sessionId)}/review`, { method: "POST", body: {} }, permissiveStatuses);

      if (turnId) {
        await api(
          `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/steer`,
          { method: "POST", body: { input: "Continue." } },
          permissiveStatuses
        );
      }
    }

    await api(
      `/projects/${encodeURIComponent(projectId)}/chats/move-all`,
      { method: "POST", body: { destination: "unassigned" } },
      [200]
    );

    await api(
      `/sessions/${encodeURIComponent(sessionId)}/project`,
      { method: "POST", body: { projectId } },
      [200]
    );

    await api(`/projects/${encodeURIComponent(projectId)}/chats/delete-all`, { method: "POST", body: {} }, [200]);

    const deletedSession = await api(`/sessions/${encodeURIComponent(sessionId)}`, {}, [410]);
    assert.equal(deletedSession.json?.status, "deleted");

    await api(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }, [200]);

    console.log("SMOKE_OK: API and websocket lifecycle checks passed");
  } finally {
    if (socket) {
      socket.close();
    }

    for (const sessionId of createdSessionIds) {
      await api(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, [200, 404, 410]);
    }

    for (const projectId of createdProjectIds) {
      await api(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }, [200, 404, 409]);
    }
  }
}

await main();
