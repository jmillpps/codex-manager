import { describe, expect, it } from "vitest";

import { extractMarkdownSectionHeader, parseReasoningLines } from "../src/App";

describe("extractMarkdownSectionHeader", () => {
  it("detects leading bold prefix and keeps trailing text as remainder", () => {
    expect(extractMarkdownSectionHeader("**Planning** draft the update")).toEqual({
      title: "Planning",
      remainder: "draft the update"
    });
  });

  it("returns null remainder when line only contains a bold title", () => {
    expect(extractMarkdownSectionHeader("**Planning**")).toEqual({
      title: "Planning",
      remainder: null
    });
  });

  it("captures additional non-empty lines into remainder", () => {
    expect(extractMarkdownSectionHeader("**Planning** first line\n\nsecond line")).toEqual({
      title: "Planning",
      remainder: "first line\n\nsecond line"
    });
  });

  it("ignores strings that do not start with a bold prefix", () => {
    expect(extractMarkdownSectionHeader("Planning only")).toBeNull();
    expect(extractMarkdownSectionHeader("intro\n**Planning** second line")).toBeNull();
  });
});

describe("parseReasoningLines", () => {
  it("preserves markdown formatting in summary/content lines", () => {
    const details = JSON.stringify({
      summary: ["**Planning** draft update"],
      content: [{ text: "**Changes** update docs and tests" }]
    });

    expect(parseReasoningLines(details)).toEqual({
      summaryLines: ["**Planning** draft update"],
      contentLines: ["**Changes** update docs and tests"]
    });
  });

  it("preserves markdown in fallback content when details are absent", () => {
    expect(parseReasoningLines(undefined, "**Planning** draft update")).toEqual({
      summaryLines: ["**Planning** draft update"],
      contentLines: []
    });
  });
});

