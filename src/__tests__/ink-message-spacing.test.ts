import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage, DisplayMessagePart } from "../tui-ink/display-history.js";

const terminalColumns = 90;

function renderLines(messages: DisplayMessage[], streamingParts: DisplayMessagePart[] = []): string[] {
  return renderToString(renderMessageList(messages, terminalColumns, streamingParts), { columns: terminalColumns })
    .split("\n");
}

function renderMessageList(
  messages: DisplayMessage[],
  columns: number,
  streamingParts: DisplayMessagePart[] = [],
): React.ReactElement {
  return React.createElement(MessageList, {
    messages,
    streamingContent: "",
    streamingReasoning: "",
    streamingTools: [],
    streamingParts,
    terminalColumns: columns,
    verboseTrace: false,
  });
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

  it("gives the first streaming tool trace the same gap as a committed turn", () => {
    const lines = renderLines([user], [toolsPart]);

    expect(lines[0]).toContain("What is this project doing?");
    expect(lines[0]).toContain("▌");
    // Same blank line as after finalize — spacing must not jump when the
    // streaming block commits into a regular assistant message.
    expect(lines[1]).toBe("");
    expect(lines[2]).toContain("List Directory 2 files");
  });

  it("renders sent user messages with a continuous rail and bubble fill", () => {
    const output = renderLines([{ key: "short-user", role: "user", content: "你好啊" }]).join("\n");

    expect(output).toContain("▌  你好啊");
  });

  it("keeps tool trace titles visible beside long commands", () => {
    const output = renderLines([
      {
        key: "assistant-tools",
        role: "assistant",
        content: "",
        parts: [{
          type: "tools",
          toolCalls: [
            {
              id: "bash-1",
              name: "bash",
              args: { command: "cd /Users/chengshengdeng/coworker && find src -type f | head -120" },
              result: "src/electron/main.ts\nsrc/renderer/App.tsx",
            },
            {
              id: "glob-1",
              name: "glob",
              args: { pattern: "*.ts" },
              result: "src/electron/main.ts\nsrc/renderer/App.tsx",
            },
          ],
        }],
      },
    ]).join("\n");

    expect(output).toContain("Execute");
    expect(output).toContain("find src -type f");
    expect(output).toContain("Find Files");
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

  it("shows completed edit diffs inline with a 20-line default preview", () => {
    const diff = [
      "--- a.ts\toriginal",
      "+++ a.ts\tmodified",
      "@@ -1,1 +1,23 @@",
      " keep",
      ...Array.from({ length: 22 }, (_, index) => `+added ${index + 1}`),
    ].join("\n");

    const lines = renderLines([
      {
        key: "assistant-edit",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tools",
            toolCalls: [
              {
                id: "edit-1",
                name: "edit",
                args: { path: "a.ts" },
                result: `Edited a.ts\n\nDiff:\n${diff}`,
                metadata: {
                  kind: "edit",
                  path: "a.ts",
                  diff,
                  addedLines: 22,
                  removedLines: 0,
                },
              },
            ],
          },
        ],
      },
    ]);

    const output = lines.join("\n");
    expect(output).toContain("Edit a.ts");
    expect(output).toContain("Succeeded. File edited. (+22 added)");
    expect(output).toContain("added 19");
    expect(output).not.toContain("added 20");
    expect(output).toContain("+3 lines");
    expect(output).toContain("ctrl+o to expand");
  });

  it("keeps committed history renderable for terminal scrollback", () => {
    const messages: DisplayMessage[] = Array.from({ length: 100 }, (_, index) => ({
      key: `msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `window-message-${index}`,
    }));

    const output = renderToString(
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
    );

    expect(output).toContain("window-message-0");
    expect(output).toContain("window-message-60");
    expect(output).toContain("window-message-99");
    expect(output).not.toContain("hidden");
  });
});
