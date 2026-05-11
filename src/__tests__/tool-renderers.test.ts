import { describe, expect, it, vi } from "vitest";
import { StreamingRedrawThrottler } from "../tui/streaming-redraw.js";
import { finishStreamingToolCall, upsertStreamingToolCall } from "../tui/tool-renderers/streaming.js";
import { formatWritePreview } from "../tui/tool-renderers/write-preview.js";
import type { DisplayToolCall } from "../tui/display-history.js";

describe("tool renderer streaming state", () => {
  it("extracts partial write arguments while the tool call is still streaming", () => {
    const toolCalls: DisplayToolCall[] = [];

    upsertStreamingToolCall(toolCalls, "call-1", "write", "{\"path\":\"/tmp/a.html\",\"content\":\"line 1\\nline");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.status).toBe("pending");
    expect(toolCalls[0]?.streamingArgs).toBe(true);
    expect(toolCalls[0]?.args).toEqual({
      path: "/tmp/a.html",
      content: "line 1\nline",
    });
  });

  it("replaces partial arguments with parsed final arguments when streaming ends", () => {
    const toolCalls: DisplayToolCall[] = [];

    upsertStreamingToolCall(toolCalls, "call-1", "write", "{\"path\":\"/tmp/a.html\",\"content\":\"draft");
    finishStreamingToolCall(toolCalls, "call-1", "write", "{\"path\":\"/tmp/a.html\",\"content\":\"final\"}");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.streamingArgs).toBe(false);
    expect(toolCalls[0]?.args).toEqual({
      path: "/tmp/a.html",
      content: "final",
    });
  });
});

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

describe("streaming redraw throttler", () => {
  it("throttles streaming tool-call redraws while allowing normal redraws immediately", () => {
    vi.useFakeTimers();
    try {
      const throttler = new StreamingRedrawThrottler(80);
      const redraw = vi.fn();

      expect(throttler.schedule("streaming-tool-call", redraw)).toBe(true);
      expect(throttler.schedule("streaming-tool-call", redraw)).toBe(false);
      expect(redraw).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(79);
      expect(redraw).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(redraw).toHaveBeenCalledTimes(2);

      throttler.schedule("normal", redraw);
      expect(redraw).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
