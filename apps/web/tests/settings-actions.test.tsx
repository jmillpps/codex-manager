import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("settings endpoint wiring", () => {
  const originalWebSocket = globalThis.WebSocket;
  let fetchMock: ReturnType<typeof vi.fn>;
  let promptSpy: ReturnType<typeof vi.spyOn>;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
              details: {},
              createdAt: new Date().toISOString(),
              status: "pending"
            }
          })
        })
      );
    });

    await screen.findByText("Approval needed for command execution");

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

    await screen.findByText(/Approved for this turn\./);
  });
});
