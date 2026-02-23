import type { InvokeApiResult } from "./http.js";
import type { RuntimeContext } from "./runtime.js";

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function printSuccess(ctx: RuntimeContext, result: InvokeApiResult): void {
  if (ctx.outputJson) {
    process.stdout.write(
      `${prettyJson({
        ok: true,
        command: result.command,
        request: {
          method: result.request.method,
          path: result.request.path,
          url: result.request.url
        },
        response: {
          statusCode: result.response.statusCode,
          body: result.response.body
        }
      })}\n`
    );
    return;
  }

  process.stdout.write(`Status: ${result.response.statusCode}\n`);
  process.stdout.write(`${prettyJson(result.response.body)}\n`);
}

export function printError(ctx: RuntimeContext, command: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  if (ctx.outputJson) {
    process.stderr.write(
      `${prettyJson({
        ok: false,
        command,
        error: {
          kind: "command_failed",
          message
        }
      })}\n`
    );
    return;
  }

  process.stderr.write(`Error: ${message}\n`);
}
