import { describe, expect, it } from "vitest";
import { extractStreamingArgsHint } from "../tui/streaming-tool-args.js";

describe("extractStreamingArgsHint", () => {
  it("returns empty hint for an empty buffer", () => {
    expect(extractStreamingArgsHint("")).toEqual({ path: undefined, newlineCount: 0 });
  });

  it("extracts a closed path value", () => {
    const raw = `{"path":"src/foo.ts","content":"export const a = 1;`;
    expect(extractStreamingArgsHint(raw).path).toBe("src/foo.ts");
  });

  it("waits for the closing quote before exposing the path", () => {
    const raw = `{"path":"src/fo`;
    expect(extractStreamingArgsHint(raw).path).toBeUndefined();
  });

  it("handles file_path and filePath aliases", () => {
    expect(extractStreamingArgsHint(`{"file_path":"a.ts"}`).path).toBe("a.ts");
    expect(extractStreamingArgsHint(`{"filePath":"b.ts"}`).path).toBe("b.ts");
  });

  it("decodes JSON escapes inside the path", () => {
    const raw = `{"path":"src/with \\\"quote\\\".ts","content":"`;
    expect(extractStreamingArgsHint(raw).path).toBe(`src/with "quote".ts`);
  });

  it("counts escaped newlines in the buffer", () => {
    const raw = `{"path":"a.ts","content":"line1\\nline2\\nline3`;
    expect(extractStreamingArgsHint(raw).newlineCount).toBe(2);
  });

  it("does not crash on a malformed escape at the boundary", () => {
    const raw = `{"path":"src/foo\\`;
    const hint = extractStreamingArgsHint(raw);
    expect(hint.path).toBeUndefined();
    expect(hint.newlineCount).toBe(0);
  });
});
