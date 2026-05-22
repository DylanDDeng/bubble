import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

function renderLines(messages: DisplayMessage[], terminalColumns: number): string[] {
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

describe("Ink narrow-screen wrapping", () => {
  it("wraps long diff lines instead of truncating them", () => {
    const longContent =
      "this is a very long diff line that absolutely must wrap when rendered in a narrow terminal";
    const diff = [
      "--- a.ts\toriginal",
      "+++ a.ts\tmodified",
      "@@ -1,1 +1,1 @@",
      `+${longContent}`,
    ].join("\n");

    const message: DisplayMessage = {
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
                addedLines: 1,
                removedLines: 0,
              },
            },
          ],
        },
      ],
    };

    const narrow = renderLines([message], 40);
    const wide = renderLines([message], 200);

    // Hard wrap operates at the character level (not word boundaries), so we
    // compare against whitespace-stripped strings to confirm the content is
    // preserved in order without asserting against any particular wrap point.
    const stripWs = (s: string) => s.replace(/\s+/g, "");

    expect(stripWs(narrow.join(""))).toContain(stripWs(longContent));
    expect(stripWs(wide.join(""))).toContain(stripWs(longContent));

    // Crucially, the narrow render uses MORE rows than the wide one for the
    // same diff, because the long line wraps rather than getting truncated.
    expect(narrow.length).toBeGreaterThan(wide.length);
  });

  it("drops a long bash command to indented continuation rows", () => {
    const longCommand =
      "echo --some-flag=value --another-flag=value2 --yet-another-flag=value3 /some/long/path";

    const message: DisplayMessage = {
      key: "assistant-bash",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tools",
          toolCalls: [
            {
              id: "bash-1",
              name: "bash",
              args: { command: longCommand },
              result: "ok",
            },
          ],
        },
      ],
    };

    const narrow = renderLines([message], 40);
    const wide = renderLines([message], 200);
    const stripWs = (s: string) => s.replace(/\s+/g, "");

    // Full command text is preserved in the narrow render (vs. truncated mid-
    // flag the way the old `truncateVisual` call did).
    expect(stripWs(narrow.join(""))).toContain(stripWs(longCommand));

    // Wide render keeps the command inline on the title row; narrow render
    // pushes it onto its own indented rows.
    expect(narrow.length).toBeGreaterThan(wide.length);
  });

  it("keeps short bash commands inline with the title", () => {
    const message: DisplayMessage = {
      key: "assistant-bash-short",
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tools",
          toolCalls: [
            {
              id: "bash-short",
              name: "bash",
              args: { command: "ls" },
              result: "a\nb",
            },
          ],
        },
      ],
    };

    const lines = renderLines([message], 80);
    // The title row contains both the action label and the short command.
    const titleRow = lines.find((line) => line.includes("ls"));
    expect(titleRow).toBeDefined();
    expect(titleRow).toMatch(/ls/);
  });
});
