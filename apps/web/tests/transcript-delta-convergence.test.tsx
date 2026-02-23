import { act, render, screen, waitFor } from "@testing-library/react";
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

  send(): void {
    // no-op
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

describe("transcript websocket delta convergence", () => {
  const originalWebSocket = globalThis.WebSocket;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/projects")) {
        return json({ data: [] });
      }
      if (url.includes("/api/sessions?")) {
        return json({
          data: [
            {
              sessionId: "session-1",
              title: "Session 1",
              materialized: true,
              modelProvider: "default",
              approvalPolicy: "on-failure",
              sessionControls: {
                model: null,
                approvalPolicy: "on-failure",
                networkAccess: "restricted",
                filesystemSandbox: "read-only"
              },
              createdAt: Date.now(),
              updatedAt: Date.now(),
              cwd: "/tmp",
              source: "thread",
              projectId: null
            }
          ],
          nextCursor: null,
          archived: false
        });
      }
      if (url.includes("/api/sessions/session-1/session-controls")) {
        return json({
          status: "ok",
          sessionId: "session-1",
          controls: {
            model: null,
            approvalPolicy: "on-failure",
            networkAccess: "restricted",
            filesystemSandbox: "read-only"
          },
          defaults: {
            model: null,
            approvalPolicy: "on-failure",
            networkAccess: "restricted",
            filesystemSandbox: "read-only"
          },
          defaultsEditable: true,
          defaultLockReason: null
        });
      }
      if (url.includes("/api/sessions/session-1/approvals")) {
        return json({ data: [] });
      }
      if (url.includes("/api/sessions/session-1/tool-input")) {
        return json({ data: [] });
      }
      if (url.includes("/api/sessions/session-1")) {
        return json({
          session: {
            sessionId: "session-1",
            title: "Session 1",
            materialized: true,
            modelProvider: "default",
            approvalPolicy: "on-failure",
            sessionControls: {
              model: null,
              approvalPolicy: "on-failure",
              networkAccess: "restricted",
              filesystemSandbox: "read-only"
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            cwd: "/tmp",
            source: "thread",
            projectId: null
          },
          transcript: [
            {
              messageId: "user-1",
              turnId: "turn-1",
              role: "user",
              type: "message",
              content: "Seed request",
              status: "complete"
            }
          ]
        });
      }
      if (url.includes("/api/models")) {
        return json({ data: [] });
      }
      if (url.includes("/api/mcp/servers")) {
        return json({ data: [] });
      }
      if (url.includes("/api/capabilities")) {
        return json({
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
      if (url.includes("/api/account")) {
        return json({});
      }
      if (url.includes("/api/account/rate-limits")) {
        return json({});
      }
      if (url.includes("/api/apps")) {
        return json({ data: [] });
      }
      if (url.includes("/api/skills")) {
        return json({ data: [] });
      }
      if (url.includes("/api/collaboration/modes")) {
        return json({ data: [], nextCursor: null });
      }
      if (url.includes("/api/features/experimental")) {
        return json({ data: [], nextCursor: null });
      }
      if (url.includes("/api/config")) {
        return json({});
      }
      return json({});
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it("applies transcript_updated websocket entry immediately for active session", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Session 1" });
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });

    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(socket).toBeTruthy();

    await act(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "transcript_updated",
            threadId: "session-1",
            payload: {
              threadId: "session-1",
              entry: {
                messageId: "assistant-1",
                turnId: "turn-1",
                role: "assistant",
                type: "message",
                content: "Delta-applied assistant reply",
                status: "complete"
              }
            }
          })
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Delta-applied assistant reply")).toBeInTheDocument();
    });
  });

  it("drops stale completed websocket-only messages when transcript hydration does not include them", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Session 1" });
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });

    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(socket).toBeTruthy();

    await act(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "notification",
            threadId: "session-1",
            payload: {
              method: "item/completed",
              params: {
                turnId: "turn-1",
                item: {
                  id: "assistant-ghost",
                  type: "agentMessage",
                  text: "Stale websocket-only message"
                }
              }
            }
          })
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Stale websocket-only message")).toBeInTheDocument();
    });

    await act(async () => {
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "transcript_updated",
            threadId: "session-1",
            payload: {
              threadId: "session-1"
            }
          })
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("Stale websocket-only message")).not.toBeInTheDocument();
    });
  });
});
