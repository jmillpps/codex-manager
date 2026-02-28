export type JsonRpcSignalId = number | string;

export type JsonRpcNotificationSignal = {
  method: string;
  params?: unknown;
};

export type JsonRpcServerRequestSignal = {
  id: JsonRpcSignalId;
  method: string;
  params?: unknown;
};

export type AppServerSignalKind = "notification" | "request";

export type AppServerSignalSession = {
  id: string;
  title: string | null;
  projectId: string | null;
};

export type AppServerSignalEnvelope = {
  source: "app_server";
  signalType: AppServerSignalKind;
  eventType: string;
  method: string;
  receivedAt: string;
  context: {
    threadId: string | null;
    turnId: string | null;
  };
  params: unknown;
  session: AppServerSignalSession | null;
  requestId?: JsonRpcSignalId;
};

type AppServerNotificationSignalInput = {
  notification: JsonRpcNotificationSignal;
  threadId?: string | null;
  turnId?: string | null;
  session?: AppServerSignalSession | null;
  receivedAt?: string;
};

type AppServerRequestSignalInput = {
  request: JsonRpcServerRequestSignal;
  threadId?: string | null;
  turnId?: string | null;
  session?: AppServerSignalSession | null;
  receivedAt?: string;
};

function normalizeSegment(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed.length === 0) {
    return "unknown";
  }

  return trimmed
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function normalizeAppServerSignalMethod(method: string): string {
  const normalized = method
    .split("/")
    .map((segment) => normalizeSegment(segment))
    .filter((segment) => segment.length > 0);
  return normalized.length > 0 ? normalized.join(".") : "unknown";
}

export function toAppServerNotificationEventType(method: string): string {
  return `app_server.${normalizeAppServerSignalMethod(method)}`;
}

export function toAppServerRequestEventType(method: string): string {
  return `app_server.request.${normalizeAppServerSignalMethod(method)}`;
}

export function buildAppServerNotificationSignal(input: AppServerNotificationSignalInput): {
  eventType: string;
  payload: AppServerSignalEnvelope;
} {
  const eventType = toAppServerNotificationEventType(input.notification.method);
  return {
    eventType,
    payload: {
      source: "app_server",
      signalType: "notification",
      eventType,
      method: input.notification.method,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      context: {
        threadId: input.threadId ?? null,
        turnId: input.turnId ?? null
      },
      params: input.notification.params ?? null,
      session: input.session ?? null
    }
  };
}

export function buildAppServerRequestSignal(input: AppServerRequestSignalInput): {
  eventType: string;
  payload: AppServerSignalEnvelope;
} {
  const eventType = toAppServerRequestEventType(input.request.method);
  return {
    eventType,
    payload: {
      source: "app_server",
      signalType: "request",
      eventType,
      method: input.request.method,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      context: {
        threadId: input.threadId ?? null,
        turnId: input.turnId ?? null
      },
      params: input.request.params ?? null,
      session: input.session ?? null,
      requestId: input.request.id
    }
  };
}
