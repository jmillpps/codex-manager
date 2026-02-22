/**
 * Shared text helpers for agent job-instruction generation.
 */

export function valueOrPlaceholder(value: string | undefined, placeholder = "not provided"): string {
  return value && value.trim().length > 0 ? value : `[${placeholder}]`;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

