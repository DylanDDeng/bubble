import { describe, expect, it } from "vitest";
import { formatWritePreview } from "../tui/tool-renderers/write-preview.js";

describe("write preview formatting", () => {
  it("collapses long writes by line count", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    const preview = formatWritePreview(content, false);

    expect(preview.content.split("\n")).toHaveLength(10);
    expect(preview.omittedLines).toBe(2);
    expect(preview.omittedChars).toBeGreaterThan(0);
  });

  it("returns full content when expanded", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    const preview = formatWritePreview(content, true);

    expect(preview.content).toBe(content);
    expect(preview.omittedLines).toBe(0);
    expect(preview.omittedChars).toBe(0);
  });
});
