import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

const columns = 100;
const REASONING = Array.from({ length: 12 }, (_, i) => `thought line ${i + 1}`).join("\n");

function render(opts: {
  streaming?: boolean;
  showThinking?: boolean;
  verboseTrace?: boolean;
}): string {
  const settled: DisplayMessage[] = opts.streaming
    ? []
    : [{ key: "a", role: "assistant", content: "done", reasoning: REASONING }];
  return renderToString(
    React.createElement(MessageList, {
      messages: settled,
      streamingContent: opts.streaming ? "working" : "",
      streamingReasoning: opts.streaming ? REASONING : "",
      streamingTools: [],
      streamingParts: [],
      terminalColumns: columns,
      verboseTrace: opts.verboseTrace ?? false,
      showThinking: opts.showThinking ?? false,
    }),
    { columns },
  );
}

describe("reasoning trace display", () => {
  it("streams a rolling window of the most recent lines", () => {
    const out = render({ streaming: true });

    // Latest lines visible, earliest scrolled out — always something moving.
    expect(out).toContain("thought line 12");
    expect(out).toContain("thought line 8");
    expect(out).not.toContain("thought line 1 ");
    expect(out).toContain("Thinking…");
    expect(out).not.toContain("Reasoning trace");
    expect(out).not.toContain("more lines");
  });

  it("collapses a settled turn to its opening lines plus an expand hint", () => {
    const out = render({});

    expect(out).toContain("thought line 1");
    expect(out).not.toContain("thought line 12");
    expect(out).toContain("Thinking");
    expect(out).not.toContain("Reasoning trace");
    expect(out).not.toContain("12 lines");
    expect(out).not.toContain("more lines");
    expect(out).toContain("ctrl+o to expand");
  });

  it("shows everything under Ctrl+T thinking or Ctrl+O verbose", () => {
    for (const out of [render({ showThinking: true }), render({ verboseTrace: true })]) {
      expect(out).toContain("thought line 1");
      expect(out).toContain("thought line 12");
      expect(out).not.toContain("ctrl+o to expand");
    }
  });

  it("keeps a reasoning-only turn visible instead of dropping the row", () => {
    const out = renderToString(
      React.createElement(MessageList, {
        messages: [{ key: "r", role: "assistant", content: "", reasoning: REASONING }],
        streamingContent: "",
        streamingReasoning: "",
        streamingTools: [],
        streamingParts: [],
        terminalColumns: columns,
        verboseTrace: false,
        showThinking: false,
      }),
      { columns },
    );

    expect(out).toContain("thought line 1");
  });
});
