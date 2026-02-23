import type { RuntimeContext } from "./runtime.js";

export type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type InvokeApiInput = {
  command: string;
  method: RequestMethod;
  pathTemplate: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  allowStatuses?: Array<number>;
  headers?: Record<string, string>;
};

export type InvokeApiResult = {
  command: string;
  request: {
    method: RequestMethod;
    path: string;
    url: string;
    query: Record<string, string | number | boolean | null | undefined>;
  };
  response: {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
    rawText: string;
  };
};

function withPathParams(pathTemplate: string, pathParams: Record<string, string>): string {
  let next = pathTemplate;
  for (const [key, value] of Object.entries(pathParams)) {
    next = next.replaceAll(`:${key}`, encodeURIComponent(value));
  }
  return next;
}

function normalizeApiPath(ctx: RuntimeContext, path: string): string {
  const prefix = ctx.apiPrefix;
  if (path === "/api") {
    return prefix;
  }
  if (path.startsWith("/api/")) {
    return `${prefix}${path.slice(4)}`;
  }
  if (path.startsWith("/")) {
    if (path.startsWith(`${prefix}/`) || path === prefix) {
      return path;
    }
    return `${prefix}${path}`;
  }
  return `${prefix}/${path}`;
}

function makeQueryString(query: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
      continue;
    }
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

function headersToRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

export async function invokeApi(ctx: RuntimeContext, input: InvokeApiInput): Promise<InvokeApiResult> {
  const pathWithParams = withPathParams(input.pathTemplate, input.pathParams ?? {});
  const normalizedPath = normalizeApiPath(ctx, pathWithParams);
  const query = input.query ?? {};
  const queryString = makeQueryString(query);
  const url = `${ctx.baseUrl}${normalizedPath}${queryString}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...ctx.headers,
    ...(input.headers ?? {})
  };

  let body: string | undefined;
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, Math.max(1, ctx.timeoutMs));

  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method,
      headers,
      body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await response.text();
  let parsedBody: unknown = rawText;
  if (rawText.trim().length > 0) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      parsedBody = rawText;
    }
  }

  const allowStatuses = input.allowStatuses ?? [200];
  if (!allowStatuses.includes(response.status)) {
    const detail = typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody);
    throw new Error(`HTTP ${response.status} for ${input.method} ${normalizedPath}: ${detail}`);
  }

  return {
    command: input.command,
    request: {
      method: input.method,
      path: normalizedPath,
      url,
      query
    },
    response: {
      statusCode: response.status,
      headers: headersToRecord(response.headers),
      body: parsedBody,
      rawText
    }
  };
}
