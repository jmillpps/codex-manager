import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppServerNotificationSignal,
  buildAppServerRequestSignal,
  normalizeAppServerSignalMethod,
  toAppServerNotificationEventType,
  toAppServerRequestEventType
} from "./app-server-signals.js";

test("normalizeAppServerSignalMethod converts slash and camel-case methods to dot + snake_case", () => {
  assert.equal(normalizeAppServerSignalMethod("turn/started"), "turn.started");
  assert.equal(normalizeAppServerSignalMethod("thread/tokenUsage/updated"), "thread.token_usage.updated");
  assert.equal(normalizeAppServerSignalMethod("mcpServer/oauthLogin/completed"), "mcp_server.oauth_login.completed");
  assert.equal(normalizeAppServerSignalMethod("execCommandApproval"), "exec_command_approval");
});

test("event type helpers produce app_server prefixes", () => {
  assert.equal(toAppServerNotificationEventType("item/fileChange/outputDelta"), "app_server.item.file_change.output_delta");
  assert.equal(
    toAppServerRequestEventType("item/fileChange/requestApproval"),
    "app_server.request.item.file_change.request_approval"
  );
});

test("buildAppServerNotificationSignal returns a stable generic envelope", () => {
  const signal = buildAppServerNotificationSignal({
    notification: {
      method: "turn/completed",
      params: {
        threadId: "thread-1"
      }
    },
    threadId: "thread-1",
    turnId: "turn-1",
    session: {
      id: "thread-1",
      title: "New chat",
      projectId: "project-1"
    },
    receivedAt: "2026-02-25T00:00:00.000Z"
  });

  assert.equal(signal.eventType, "app_server.turn.completed");
  assert.deepEqual(signal.payload, {
    source: "app_server",
    signalType: "notification",
    eventType: "app_server.turn.completed",
    method: "turn/completed",
    receivedAt: "2026-02-25T00:00:00.000Z",
    context: {
      threadId: "thread-1",
      turnId: "turn-1"
    },
    session: {
      id: "thread-1",
      title: "New chat",
      projectId: "project-1"
    },
    params: {
      threadId: "thread-1"
    }
  });
});

test("buildAppServerRequestSignal includes request id and null defaults", () => {
  const signal = buildAppServerRequestSignal({
    request: {
      id: 42,
      method: "item/tool/requestUserInput"
    },
    receivedAt: "2026-02-25T00:00:00.000Z"
  });

  assert.equal(signal.eventType, "app_server.request.item.tool.request_user_input");
  assert.deepEqual(signal.payload, {
    source: "app_server",
    signalType: "request",
    eventType: "app_server.request.item.tool.request_user_input",
    method: "item/tool/requestUserInput",
    receivedAt: "2026-02-25T00:00:00.000Z",
    context: {
      threadId: null,
      turnId: null
    },
    params: null,
    session: null,
    requestId: 42
  });
});
