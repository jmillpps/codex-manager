import { readFile } from "node:fs/promises";

export async function parseJsonInput(value: string): Promise<unknown> {
  const source = value.trim();
  if (!source) {
    throw new Error("json input is empty");
  }

  if (source.startsWith("@")) {
    const file = source.slice(1);
    const content = await readFile(file, "utf8");
    return JSON.parse(content);
  }

  return JSON.parse(source);
}

export function parseMaybeBoolean(value: string | undefined): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return undefined;
}

export function parseCsvList(value: string | undefined): Array<string> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const items = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

export async function parseTextInput(input: {
  value?: string;
  file?: string;
  field: string;
  required?: boolean;
}): Promise<string | undefined> {
  const hasValue = typeof input.value === "string";
  const hasFile = typeof input.file === "string" && input.file.trim().length > 0;

  if (hasValue && hasFile) {
    throw new Error(`--${input.field} and --${input.field}-file are mutually exclusive`);
  }

  if (hasFile) {
    const content = await readFile(input.file!.trim(), "utf8");
    if (!input.required) {
      return content;
    }
    if (content.trim().length === 0) {
      throw new Error(`--${input.field}-file content is empty`);
    }
    return content;
  }

  if (hasValue) {
    if (!input.required) {
      return input.value;
    }
    if (input.value!.trim().length === 0) {
      throw new Error(`--${input.field} is empty`);
    }
    return input.value;
  }

  if (input.required) {
    throw new Error(`--${input.field} or --${input.field}-file is required`);
  }

  return undefined;
}
