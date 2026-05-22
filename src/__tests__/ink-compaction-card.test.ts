import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import { latestCompactionSummary, type DisplayMessage } from "../tui-ink/display-history.js";
import type { Message } from "../types.js";

const terminalColumns = 90;

function renderLines(messages: DisplayMessage[]): string[] {
  return renderToString(
    React.createElement(MessageList, {
      messages,
      streamingContent: "",
      streamingReasoning: "",
      streamingTools: [],
      streamingParts: [],
      terminalColumns,
      verboseTrace: false,
    }),
    { columns: terminalColumns },
  ).split("\n");
}

describe("Ink compaction summary card", () => {
  it("renders header, status, and markdown summary", () => {
    const card: DisplayMessage = {
      key: "card-1",
      role: "assistant",
      content: "✓ Compaction complete · 4 log entries summarized",
      syntheticKind: "ui_compact_summary",
      compactionSummary: "## Recent work\n\n- Refactored auth\n- Fixed retry logic",
    };

    const output = renderLines([card]).join("\n");

    expect(output).toContain("✓");
    expect(output).toContain("Compaction");
    expect(output).toContain("Compaction complete · 4 log entries summarized");
    expect(output).toContain("Recent work");
    expect(output).toContain("Refactored auth");
    expect(output).toContain("Fixed retry logic");
  });

  it("renders without a summary when none is provided", () => {
    const card: DisplayMessage = {
      key: "card-2",
      role: "assistant",
      content: "✓ Compaction complete",
      syntheticKind: "ui_compact_summary",
    };

    const output = renderLines([card]).join("\n");

    expect(output).toContain("Compaction");
    expect(output).toContain("Compaction complete");
    // No summary body to render — the card collapses to its header line.
    expect(output).not.toContain("Refactored");
  });

  it("falls back to a default status when content is empty", () => {
    const card: DisplayMessage = {
      key: "card-3",
      role: "assistant",
      content: "",
      syntheticKind: "ui_compact_summary",
    };

    const output = renderLines([card]).join("\n");

    expect(output).toContain("Session compacted");
  });
});

describe("latestCompactionSummary", () => {
  it("returns the freshest Previous-conversation-summary block", () => {
    const messages: Message[] = [
      { role: "system", content: "Previous conversation summary:\nOlder summary body." },
      { role: "user", content: "noise" },
      { role: "system", content: "Previous conversation summary:\nNewer summary body." },
    ];
    expect(latestCompactionSummary(messages)).toBe("Newer summary body.");
  });

  it("returns turn-level summaries when no full-history summary exists", () => {
    const messages: Message[] = [
      { role: "system", content: "Earlier in this turn (compacted to free context):\nTurn-level recap." },
    ];
    expect(latestCompactionSummary(messages)).toBe("Turn-level recap.");
  });

  it("returns undefined when no compaction block is present", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello." },
    ];
    expect(latestCompactionSummary(messages)).toBeUndefined();
  });
});
