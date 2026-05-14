import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage, DisplayMessagePart } from "../tui-ink/display-history.js";

const terminalColumns = 90;

function renderLines(messages: DisplayMessage[], streamingParts: DisplayMessagePart[] = []): string[] {
  return renderToString(
    React.createElement(MessageList, {
      messages,
      streamingContent: "",
      streamingReasoning: "",
      streamingTools: [],
      streamingParts,
      terminalColumns,
      verboseTrace: false,
    }),
    { columns: terminalColumns },
  ).split("\n");
}

describe("Ink message spacing", () => {
  const user: DisplayMessage = {
    key: "user",
    role: "user",
    content: "What is this project doing?",
  };

  const toolsPart: DisplayMessagePart = {
    type: "tools",
    toolCalls: [
      {
        id: "tool-1",
        name: "glob",
        args: { pattern: "*" },
        result: "a.html\nb.html",
      },
    ],
  };

  const textPart: DisplayMessagePart = {
    type: "text",
    content: "This is a static HTML playground.",
  };

  it("keeps a stable blank row before the first streaming tool trace", () => {
    const lines = renderLines([user], [toolsPart]);

    expect(lines[0]).toContain("What is this project doing?");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("List Directory 2 files");
  });

  it("keeps the same top spacing after the assistant turn is finalized", () => {
    const lines = renderLines([
      user,
      {
        key: "assistant",
        role: "assistant",
        content: "This is a static HTML playground.",
        parts: [toolsPart, textPart],
      },
    ]);

    expect(lines[0]).toContain("What is this project doing?");
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("List Directory 2 files");
  });
});
