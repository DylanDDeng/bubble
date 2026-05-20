import { Writable } from "node:stream";
import React from "react";
import { render, renderToString } from "ink";
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

class CaptureStream extends Writable {
  columns: number;
  rows = 40;
  isTTY = false;
  output = "";

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    callback();
  }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
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

  it("does not replay static history when terminal columns change", async () => {
    const stdout = new CaptureStream(90);
    const stderr = new CaptureStream(90);
    const sentinel: DisplayMessage = {
      key: "resize-user",
      role: "user",
      content: "Resize replay sentinel",
    };

    const instance = render(renderMessageList([sentinel], 90), {
      stdout: stdout as any,
      stderr: stderr as any,
      interactive: false,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    await instance.waitUntilRenderFlush();

    stdout.columns = 72;
    instance.rerender(renderMessageList([sentinel], 72));
    await instance.waitUntilRenderFlush();
    instance.unmount();

    expect(countOccurrences(stdout.output, "Resize replay sentinel")).toBe(1);
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
});
