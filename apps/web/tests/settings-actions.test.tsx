import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Array<MockWebSocket> = [];

  readyState = MockWebSocket.CONNECTING;
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);

    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "ready" })
        })
      );
    });
  }

  send(_payload: string): void {
    // no-op for tests
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function routeResponse(url: string): Response {
  if (url.includes("/api/sessions?")) {
    return json(200, { data: [], nextCursor: null, archived: false });
  }

  if (url.includes("/api/models?")) {
    return json(200, { data: [] });
  }

  if (url.includes("/api/mcp/servers?")) {
    return json(200, { data: [] });
  }

  if (url.endsWith("/api/projects")) {
    return json(200, { data: [] });
  }

  if (url.includes("/api/capabilities")) {
    return json(200, {
      status: "ok",
      runtime: { initialized: true, capabilitiesLastUpdatedAt: new Date().toISOString() },
      methods: {},
      details: {},
      features: {
        threadFork: true,
        reviewStart: true,
        threadCompact: true,
        threadRollback: true,
        threadBackgroundTerminalClean: true
      }
    });
  }

  if (url.endsWith("/api/account")) {
    return json(200, { loginId: "login-seed" });
  }

  if (url.endsWith("/api/account/rate-limits")) {
    return json(200, {});
  }

  if (url.includes("/api/apps?")) {
    return json(200, { data: [] });
  }

  if (url.endsWith("/api/skills")) {
    return json(200, { data: [] });
  }

  if (url.includes("/api/collaboration/modes?")) {
    return json(200, { data: [], nextCursor: null });
  }

  if (url.includes("/api/features/experimental?")) {
    return json(200, { data: [], nextCursor: null });
  }

  if (url.includes("/api/config?")) {
    return json(200, {});
  }

  if (url.endsWith("/api/config/requirements")) {
    return json(200, {});
  }

  return json(200, { status: "ok", result: {} });
}

function hasFetchCall(fetchMock: ReturnType<typeof vi.fn>, fragment: string): boolean {
  return fetchMock.mock.calls.some((args) => {
    const input = args[0];
    return String(input).includes(fragment);
  });
}

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve: ((response: Response) => void) | null = null;
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve;
  });
  return {
    promise,
    resolve: (response: Response) => {
      if (resolve) {
        resolve(response);
      }
    }
  };
}

describe("settings endpoint wiring", () => {
  const originalWebSocket = globalThis.WebSocket;
  let fetchMock: ReturnType<typeof vi.fn>;
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.clear();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.instances = [];

    fetchMock = vi.fn(async (input: RequestInfo | URL) => routeResponse(String(input)));
    vi.stubGlobal("fetch", fetchMock);

    promptSpy = vi.spyOn(window, "prompt");
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    promptSpy.mockRestore();
    confirmSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it("invokes account/skills/config/command/feedback endpoints from settings actions", async () => {
    render(<App />);

    const settingsButton = await screen.findByRole("button", { name: "Settings" });
    fireEvent.click(settingsButton);

    await screen.findByText("Settings & Integrations");

    promptSpy.mockReturnValueOnce("sk-test-key");
    fireEvent.click(screen.getByRole("button", { name: "Start API Key Login" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/account/login/start")).toBe(true));

    promptSpy.mockReturnValueOnce("login-123");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Login" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/account/login/cancel")).toBe(true));

    promptSpy.mockReturnValueOnce('[{"keyPath":"model","mergeStrategy":"upsert","value":"gpt-5"}]');
    fireEvent.click(screen.getByRole("button", { name: "Write Config Batch" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/config/batch")).toBe(true));

    promptSpy.mockReturnValueOnce("/tmp/skill-path");
    fireEvent.click(screen.getByRole("button", { name: "Enable Skill" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/skills/config")).toBe(true));

    promptSpy.mockReturnValueOnce("/tmp/skill-path");
    fireEvent.click(screen.getByRole("button", { name: "Disable Skill" }));
    await waitFor(() => {
      const configCalls = fetchMock.mock.calls.filter((args) => String(args[0]).includes("/api/skills/config"));
      expect(configCalls.length).toBeGreaterThanOrEqual(2);
    });

    promptSpy.mockReturnValueOnce("remote-skill-id");
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Set Remote Skill" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/skills/remote")).toBe(true));

    promptSpy.mockReturnValueOnce('["pwd"]');
    fireEvent.click(screen.getByRole("button", { name: "Run Command" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/commands/exec")).toBe(true));

    promptSpy.mockReturnValueOnce("ux").mockReturnValueOnce("This is useful");
    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Send Feedback" }));
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/feedback")).toBe(true));
  });

  it("processes websocket approval request and resolution envelopes", async () => {
    render(<App />);

    await screen.findByText("WebSocket connected");
    const ws = MockWebSocket.instances.at(-1);
    expect(ws).toBeDefined();

    await act(async () => {
      ws?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "approval",
            payload: {
              approvalId: "approval-1",
              method: "item/commandExecution/requestApproval",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-1",
              summary: "Approval needed for command execution",
              details: {
                command: "echo test"
              },
              createdAt: new Date().toISOString(),
              status: "pending"
            }
          })
        })
      );
    });

    await screen.findByText("Approval required to run: echo test");

    await act(async () => {
      ws?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "approval_resolved",
            payload: {
              approvalId: "approval-1",
              status: "resolved",
              decision: "accept",
              scope: "turn"
            }
          })
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Approval required to run: echo test")).not.toBeInTheDocument();
    });
    await screen.findByText("Idle");
  });

  it("ignores stale transcript and approval responses after switching sessions", async () => {
    const createdAt = new Date().toISOString();
    const sessionA = {
      sessionId: "session-a",
      title: "Session A",
      materialized: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };
    const sessionB = {
      sessionId: "session-b",
      title: "Session B",
      materialized: true,
      modelProvider: "openai",
      createdAt: 3,
      updatedAt: 4,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };

    const sessionATranscript = deferredResponse();
    const sessionAApprovals = deferredResponse();

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { data: [sessionA, sessionB], nextCursor: null, archived: false }));
      }

      if (url.endsWith("/api/sessions/session-a")) {
        return sessionATranscript.promise;
      }

      if (url.endsWith("/api/sessions/session-a/approvals")) {
        return sessionAApprovals.promise;
      }

      if (url.endsWith("/api/sessions/session-a/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-b")) {
        return Promise.resolve(
          json(200, {
            session: { sessionId: "session-b" },
            transcript: [
              {
                messageId: "b-user-1",
                turnId: "b-turn-1",
                role: "user",
                type: "userMessage",
                content: "B thread message",
                details: null,
                status: "complete"
              }
            ]
          })
        );
      }

      if (url.endsWith("/api/sessions/session-b/approvals")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-b/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    const sessionBButton = await screen.findByRole("button", { name: "Session B" });
    fireEvent.click(sessionBButton);
    await screen.findByText("B thread message");

    await act(async () => {
      sessionAApprovals.resolve(
        json(200, {
          data: [
            {
              approvalId: "stale-approval",
              method: "item/commandExecution/requestApproval",
              threadId: "session-a",
              turnId: "a-turn-1",
              itemId: "a-item-1",
              summary: "Approval required to run command",
              details: {
                command: "echo stale"
              },
              createdAt,
              status: "pending"
            }
          ]
        })
      );
      sessionATranscript.resolve(
        json(200, {
          session: { sessionId: "session-a" },
          transcript: [
            {
              messageId: "a-user-1",
              turnId: "a-turn-1",
              role: "user",
              type: "userMessage",
              content: "A thread message",
              details: null,
              status: "complete"
            }
          ]
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByText("Approval required to run: echo stale")).not.toBeInTheDocument();
      expect(screen.queryByText("A thread message")).not.toBeInTheDocument();
    });
    expect(screen.getByText("B thread message")).toBeInTheDocument();
  });

  it("preserves live approval events when approval hydration resolves with stale empty data", async () => {
    const session = {
      sessionId: "session-race",
      title: "Session Race",
      materialized: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };
    const approvalsResponse = deferredResponse();

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { data: [session], nextCursor: null, archived: false }));
      }

      if (url.endsWith("/api/sessions/session-race")) {
        return Promise.resolve(json(200, { session: { sessionId: "session-race" }, transcript: [] }));
      }

      if (url.endsWith("/api/sessions/session-race/approvals")) {
        return approvalsResponse.promise;
      }

      if (url.endsWith("/api/sessions/session-race/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    const sessionButton = await screen.findByRole("button", { name: "Session Race" });
    fireEvent.click(sessionButton);
    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/sessions/session-race/approvals")).toBe(true));

    const ws = MockWebSocket.instances.at(-1);
    expect(ws).toBeDefined();

    await act(async () => {
      ws?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "approval",
            threadId: "session-race",
            payload: {
              approvalId: "approval-race",
              method: "item/commandExecution/requestApproval",
              threadId: "session-race",
              turnId: "turn-race",
              itemId: "item-race",
              summary: "Approval needed for command execution",
              details: {
                command: "echo race"
              },
              createdAt: new Date().toISOString(),
              status: "pending"
            }
          })
        })
      );
    });

    await screen.findByText("Approval required to run: echo race");

    await act(async () => {
      approvalsResponse.resolve(json(200, { data: [] }));
      await Promise.resolve();
    });

    expect(screen.getByText("Approval required to run: echo race")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("keeps approval controls visible when transcript has approval request before approval list sync", async () => {
    const session = {
      sessionId: "session-transcript-approval",
      title: "Transcript Approval",
      materialized: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };
    const createdAt = new Date().toISOString();

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { data: [session], nextCursor: null, archived: false }));
      }

      if (url.endsWith("/api/sessions/session-transcript-approval")) {
        return Promise.resolve(
          json(200, {
            session: { sessionId: "session-transcript-approval" },
            transcript: [
              {
                messageId: "approval-approval-from-transcript",
                turnId: "turn-transcript-approval",
                role: "system",
                type: "approval.request",
                content: "Approval required to run: echo transcript",
                details: JSON.stringify({
                  method: "item/commandExecution/requestApproval",
                  command: "echo transcript",
                  createdAt
                }),
                status: "streaming"
              }
            ]
          })
        );
      }

      if (url.endsWith("/api/sessions/session-transcript-approval/approvals")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-transcript-approval/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/approvals/approval-from-transcript/decision") && init?.method === "POST") {
        return Promise.resolve(json(200, { data: { approvalId: "approval-from-transcript" } }));
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    const sessionButton = await screen.findByRole("button", { name: "Transcript Approval" });
    fireEvent.click(sessionButton);

    await screen.findByText("Approval required to run: echo transcript");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/approvals/approval-from-transcript/decision")).toBe(true));
  });

  it("keeps per-session model preference sticky across refresh hydration", async () => {
    const stickySession = {
      sessionId: "session-sticky-model",
      title: "Sticky Session",
      materialized: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };
    const modelPrefsStorageKey = `codex-manager:session-model-prefs:${window.location.pathname}`;
    window.localStorage.setItem(
      modelPrefsStorageKey,
      JSON.stringify({
        modelBySessionId: {
          "session-sticky-model": "codex-max"
        },
        effortBySessionId: {
          "session-sticky-model": "high"
        }
      })
    );

    const sessionsResponse = deferredResponse();

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/sessions?")) {
        return sessionsResponse.promise;
      }

      if (url.includes("/api/models?")) {
        return Promise.resolve(
          json(200, {
            data: [
              {
                id: "gpt-5.1",
                name: "GPT 5.1",
                provider: "openai",
                isDefault: true,
                supportedReasoningEfforts: ["minimal", "low", "medium"]
              },
              {
                id: "codex-max",
                name: "Codex Max",
                provider: "openai",
                isDefault: false,
                supportedReasoningEfforts: ["high", "xhigh"]
              }
            ]
          })
        );
      }

      if (url.endsWith("/api/sessions/session-sticky-model")) {
        return Promise.resolve(json(200, { session: { sessionId: "session-sticky-model" }, transcript: [] }));
      }

      if (url.endsWith("/api/sessions/session-sticky-model/approvals")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-sticky-model/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    await act(async () => {
      sessionsResponse.resolve(json(200, { data: [stickySession], nextCursor: null, archived: false }));
      await Promise.resolve();
    });

    await screen.findByRole("button", { name: /Codex Max/i });
    await waitFor(() => {
      const persisted = window.localStorage.getItem(modelPrefsStorageKey);
      expect(persisted).toBeTruthy();
      const parsed = JSON.parse(persisted ?? "{}") as {
        modelBySessionId?: Record<string, string>;
      };
      expect(parsed.modelBySessionId?.["session-sticky-model"]).toBe("codex-max");
    });
  });

  it("dedupes duplicate model ids and keeps selected model effort stable", async () => {
    const session = {
      sessionId: "session-model",
      title: "Session Model",
      materialized: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { data: [session], nextCursor: null, archived: false }));
      }

      if (url.includes("/api/models?")) {
        return Promise.resolve(
          json(200, {
            data: [
              {
                id: "codex-max",
                name: "Codex Max",
                provider: "openai",
                isDefault: true,
                supportedReasoningEfforts: ["high", "low"]
              },
              {
                id: "codex-max",
                name: "Codex Max Duplicate",
                provider: "openai",
                supportedReasoningEfforts: ["xhigh"]
              },
              {
                id: "gpt-lite",
                name: "GPT Lite",
                provider: "openai",
                supportedReasoningEfforts: ["minimal", "low"]
              }
            ]
          })
        );
      }

      if (/\/api\/sessions\/[^/]+$/.test(url) && !url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { session: { sessionId: "session-model" }, transcript: [] }));
      }

      if (/\/api\/sessions\/[^/]+\/approvals$/.test(url)) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (/\/api\/sessions\/[^/]+\/tool-input$/.test(url)) {
        return Promise.resolve(json(200, { data: [] }));
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    const modelButton = await screen.findByRole("button", { name: /Codex Max/i });
    fireEvent.click(modelButton);

    const menu = await screen.findByRole("menu", { name: "Select model and reasoning effort" });
    expect(menu.querySelectorAll(".model-submenu-group").length).toBe(2);

    const xhighOption = screen.getByRole("menuitemradio", { name: "XHigh" });
    fireEvent.click(xhighOption);

    await waitFor(() => {
      const trigger = document.querySelector<HTMLButtonElement>(".model-combo-trigger");
      expect(trigger).not.toBeNull();
      expect(trigger.textContent ?? "").toContain("Codex Max");
      expect(trigger.textContent ?? "").toContain("XHigh");
    });
  });

  it("toggles per-chat approval policy and sends never for that chat", async () => {
    const session = {
      sessionId: "session-approval",
      title: "Session Approval",
      materialized: true,
      modelProvider: "openai",
      approvalPolicy: "untrusted",
      createdAt: 1,
      updatedAt: 2,
      cwd: "/tmp",
      source: "persisted",
      projectId: null
    };

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/api/sessions?")) {
        return Promise.resolve(json(200, { data: [session], nextCursor: null, archived: false }));
      }

      if (url.includes("/api/models?")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-approval")) {
        return Promise.resolve(json(200, { session, transcript: [] }));
      }

      if (url.endsWith("/api/sessions/session-approval/approvals")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-approval/tool-input")) {
        return Promise.resolve(json(200, { data: [] }));
      }

      if (url.endsWith("/api/sessions/session-approval/approval-policy") && init?.method === "POST") {
        return Promise.resolve(
          json(200, {
            status: "ok",
            sessionId: "session-approval",
            approvalPolicy: "never"
          })
        );
      }

      if (url.endsWith("/api/sessions/session-approval/messages") && init?.method === "POST") {
        return Promise.resolve(
          json(202, {
            status: "accepted",
            sessionId: "session-approval",
            turnId: "turn-approval-1"
          })
        );
      }

      return Promise.resolve(routeResponse(url));
    });

    render(<App />);

    await screen.findByRole("button", { name: "Session Approval" });
    expect(screen.getByRole("button", { name: "Approvals: Unless Trusted" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approvals: Unless Trusted" }));
    const approvalPolicyMenu = await screen.findByRole("menu", { name: "Select approval policy" });
    fireEvent.click(within(approvalPolicyMenu).getByRole("menuitemradio", { name: "Never" }));
    await screen.findByRole("button", { name: "Approvals: Never" });

    const composer = screen.getByPlaceholderText("Type your message...");
    fireEvent.change(composer, { target: { value: "policy test message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(hasFetchCall(fetchMock, "/api/sessions/session-approval/messages")).toBe(true));
    const messagesCall = fetchMock.mock.calls.find((args) => String(args[0]).includes("/api/sessions/session-approval/messages"));
    expect(messagesCall).toBeDefined();
    const requestBody = JSON.parse(String((messagesCall?.[1] as RequestInit | undefined)?.body ?? "{}")) as {
      approvalPolicy?: string;
    };
    expect(requestBody.approvalPolicy).toBe("never");
  });
});
