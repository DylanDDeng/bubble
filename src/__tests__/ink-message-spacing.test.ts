import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage, DisplayMessagePart } from "../tui-ink/display-history.js";

const terminalColumns = 90;

function renderLines(
  messages: DisplayMessage[],
  streamingParts: DisplayMessagePart[] = [],
  verboseTrace = false,
): string[] {
  return renderToString(renderMessageList(messages, terminalColumns, streamingParts, verboseTrace), { columns: terminalColumns })
    .split("\n");
}

function renderMessageList(
  messages: DisplayMessage[],
  columns: number,
  streamingParts: DisplayMessagePart[] = [],
  verboseTrace = false,
): React.ReactElement {
  return React.createElement(MessageList, {
    messages,
    streamingContent: "",
    streamingReasoning: "",
    streamingTools: [],
    streamingParts,
    terminalColumns: columns,
    verboseTrace,
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

  it("keeps consecutive user messages visually separate after steer is applied", () => {
    const lines = renderLines([
      { key: "initial-user", role: "user", content: "第一条消息" },
      { key: "applied-steer", role: "user", content: "第二条 steer" },
    ]);

    const firstIndex = lines.findIndex((line) => line.includes("第一条消息"));
    const secondIndex = lines.findIndex((line) => line.includes("第二条 steer"));

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(lines.slice(firstIndex + 1, secondIndex)).toContain("");
  });

  it("renders pending steer and queued inputs as status blocks after streaming output", () => {
    const output = renderLines([
      user,
      {
        key: "pending-steer",
        role: "user",
        content: "还有 steer",
        inputStatus: "pending_steer",
      },
      {
        key: "queued-input",
        role: "user",
        content: "还有 queue",
        inputStatus: "queued",
      },
    ], [textPart]).join("\n");

    expect(output).toContain("This is a static HTML playground.");
    expect(output).toContain("Messages to steer at next model call");
    expect(output).toContain("↳ 还有 steer");
    expect(output).toContain("Messages queued for next turn");
    expect(output).toContain("↳ 还有 queue");
    expect(output).not.toContain("▌  还有 queue");
    expect(output.indexOf("This is a static HTML playground.")).toBeLessThan(
      output.indexOf("Messages to steer at next model call"),
    );
    expect(output.indexOf("This is a static HTML playground.")).toBeLessThan(
      output.indexOf("Messages queued for next turn"),
    );
    expect(output.indexOf("What is this project doing?")).toBeLessThan(
      output.indexOf("Messages to steer at next model call"),
    );
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

  it("drops an assistant turn that is only an echoed reminder, leaving no blank band", () => {
    const reminder = '<bubble_internal_reminder kind="system-reminder">\nstay on task\n</bubble_internal_reminder>';
    const lines = renderLines([
      { key: "u", role: "user", content: "go" },
      // A turn whose only text part is an echoed reminder sanitizes to empty —
      // it must render nothing (no marginTop/marginBottom band), not a blank gap.
      { key: "empty", role: "assistant", content: reminder, parts: [{ type: "text", content: reminder }] },
      { key: "answer", role: "assistant", content: "现在我有完整图景。", parts: [{ type: "text", content: "现在我有完整图景。" }] },
    ]);
    const output = lines.join("\n");

    expect(output).not.toContain("bubble_internal_reminder");
    expect(output).not.toContain("stay on task");

    const userIdx = lines.findIndex((line) => line.includes("go"));
    const answerIdx = lines.findIndex((line) => line.includes("现在我有完整图景"));
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeGreaterThan(userIdx);
    // The dropped empty turn must not stack extra margin rows: only the normal
    // single inter-message blank line sits between the user line and the answer.
    const blanksBetween = lines.slice(userIdx + 1, answerIdx).filter((line) => line.trim() === "").length;
    expect(blanksBetween).toBeLessThanOrEqual(1);
  });

  it("does not stack a blank band across consecutive echoed-reminder turns", () => {
    const reminder = '<bubble_internal_reminder kind="system-reminder">\nstay\n</bubble_internal_reminder>';
    const emptyTurn = (key: string): DisplayMessage => ({
      key,
      role: "assistant",
      content: reminder,
      parts: [{ type: "text", content: reminder }],
    });
    const lines = renderLines([
      { key: "u", role: "user", content: "go" },
      emptyTurn("e1"),
      emptyTurn("e2"),
      emptyTurn("e3"),
      { key: "answer", role: "assistant", content: "现在我有完整图景。", parts: [{ type: "text", content: "现在我有完整图景。" }] },
    ]);

    const userIdx = lines.findIndex((line) => line.includes("go"));
    const answerIdx = lines.findIndex((line) => line.includes("现在我有完整图景"));
    // Three dropped turns must add NO band — only the single inter-message gap.
    const blanksBetween = lines.slice(userIdx + 1, answerIdx).filter((line) => line.trim() === "").length;
    expect(blanksBetween).toBeLessThanOrEqual(1);
  });

  it("keeps the Task duration line on a finalized turn whose text sanitizes to empty", () => {
    const reminder = '<bubble_internal_reminder kind="system-reminder">\nstay\n</bubble_internal_reminder>';
    const output = renderLines([
      { key: "u", role: "user", content: "go" },
      // Finalized turn carries taskElapsedMs; the guard must mirror the JSX and
      // still surface the duration line even though the text sanitizes away.
      { key: "a", role: "assistant", content: reminder, parts: [{ type: "text", content: reminder }], taskElapsedMs: 5000 },
    ]).join("\n");

    expect(output).not.toContain("bubble_internal_reminder");
    expect(output).toContain("Task duration");
  });

  it("still renders a tools-only turn in verbose mode", () => {
    const output = renderLines([
      { key: "a", role: "assistant", content: "", parts: [toolsPart] },
    ], [], true).join("\n");

    // A turn with real tool rows must never be dropped by the visibility guard.
    expect(output).toContain("Glob");
    expect(output).toContain("Found 2 files");
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

  it("expands grouped read traces when verbose trace is enabled", () => {
    const toolCalls = Array.from({ length: 8 }, (_, index) => ({
      id: `read-${index + 1}`,
      name: "read",
      args: { path: `file-${index + 1}.ts` },
      result: `content from file-${index + 1}`,
    }));
    const message: DisplayMessage = {
      key: "assistant-reads",
      role: "assistant",
      content: "",
      parts: [{ type: "tools", toolCalls }],
    };

    const compact = renderLines([message]).join("\n");
    expect(compact).toContain("Read 8 files");
    expect(compact).toContain("Ctrl+O to view");
    expect(compact).not.toContain("content from file-8");

    const expanded = renderLines([message], [], true).join("\n");
    expect(expanded).toContain("Read(file-8.ts)");
    expect(expanded).toContain("content from file-8");
    expect(expanded).not.toContain("Ctrl+O to view");
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
