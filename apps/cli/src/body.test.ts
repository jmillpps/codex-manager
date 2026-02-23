import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseTextInput } from "./lib/body.js";

test("parseTextInput reads direct value", async () => {
  const value = await parseTextInput({
    value: "hello",
    field: "content",
    required: true
  });
  assert.equal(value, "hello");
});

test("parseTextInput reads file content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cli-body-test-"));
  const file = path.join(root, "content.txt");
  try {
    await writeFile(file, "from-file", "utf8");
    const value = await parseTextInput({
      file,
      field: "content",
      required: true
    });
    assert.equal(value, "from-file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseTextInput rejects mixed value and file flags", async () => {
  await assert.rejects(
    () =>
      parseTextInput({
        value: "x",
        file: "y",
        field: "content"
      }),
    /mutually exclusive/i
  );
});
