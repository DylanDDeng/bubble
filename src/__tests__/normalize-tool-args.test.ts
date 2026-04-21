import { describe, it, expect } from "vitest";
import { normalizeToolArgs } from "../provider.js";

describe("normalizeToolArgs", () => {
  it("returns {} for empty or whitespace input", () => {
    expect(normalizeToolArgs("")).toBe("{}");
    expect(normalizeToolArgs("   ")).toBe("{}");
    expect(normalizeToolArgs(null as unknown as string)).toBe("{}");
  });

  it("passes valid JSON through untouched", () => {
    expect(normalizeToolArgs('{"file_path":"/a"}')).toBe('{"file_path":"/a"}');
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeToolArgs('  {"a":1}  ')).toBe('{"a":1}');
  });

  it("recovers from duplicated snapshots (Fireworks Kimi quirk)", () => {
    const raw = '{"file_path":"/a"}{"file_path":"/a"}';
    expect(normalizeToolArgs(raw)).toBe('{"file_path":"/a"}');
  });

  it("handles nested objects when recovering", () => {
    const raw = '{"nested":{"x":1,"y":"}"}}{"nested":{"x":1,"y":"}"}}';
    expect(normalizeToolArgs(raw)).toBe('{"nested":{"x":1,"y":"}"}}');
  });

  it("survives escaped quotes in strings", () => {
    const raw = '{"q":"a\\"b"}{"q":"a\\"b"}';
    expect(normalizeToolArgs(raw)).toBe('{"q":"a\\"b"}');
  });

  it("falls back to {} for unsalvageable garbage", () => {
    expect(normalizeToolArgs("not json at all")).toBe("{}");
    expect(normalizeToolArgs("{unterminated")).toBe("{}");
  });
});
