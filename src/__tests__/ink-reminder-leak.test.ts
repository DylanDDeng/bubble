import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage, DisplayMessagePart } from "../tui-ink/display-history.js";

// A model can echo an injected <bubble_internal_reminder> block back into its
// visible answer (the reminder is projected into context as a user-role turn,
// and some models parrot it). The reasoning path strips this; the content and
// text-part paths must too, or it leaks straight into the transcript — most
// visibly when a turn is interrupted and the transcript is rebuilt.
const REMINDER = [
  '<bubble_internal_reminder kind="system-reminder">',
  "Debugging workflow:",
  "- Reproduce or identify the failing boundary before editing.",
  "- Verify the specific failure path after the change.",
  "</bubble_internal_reminder>",
].join("\n");

function render(
  messages: DisplayMessage[],
  streaming?: { content: string; parts: DisplayMessagePart[] },
): string {
  return renderToString(
    React.createElement(MessageList, {
      messages,
      streamingContent: streaming?.content ?? "",
      streamingReasoning: "",
      streamingTools: [],
      streamingParts: streaming?.parts ?? [],
      terminalColumns: 90,
      verboseTrace: false,
    }),
    { columns: 90 },
  );
}

function leaks(output: string): boolean {
  return (
    output.includes("bubble_internal_reminder") ||
    output.includes("Debugging workflow") ||
    output.includes("failing boundary")
  );
}

describe("internal reminder leak in the transcript", () => {
  it("strips an echoed reminder from assistant content, keeping the real answer", () => {
    const out = render([
      { key: "a1", role: "assistant", content: `${REMINDER}\n\nLet me read the code first.` },
    ]);
    expect(leaks(out)).toBe(false);
    expect(out).toContain("Let me read the code first");
  });

  it("strips an echoed reminder from an assistant text part", () => {
    const out = render([
      {
        key: "a2",
        role: "assistant",
        content: "",
        parts: [
          { type: "text", content: REMINDER },
          { type: "text", content: "The real answer follows." },
        ],
      },
    ]);
    expect(leaks(out)).toBe(false);
    expect(out).toContain("The real answer follows");
  });

  it("strips an echoed reminder from streaming content", () => {
    const out = render([], {
      content: `${REMINDER}\n\nStreaming the real answer.`,
      parts: [{ type: "text", content: `${REMINDER}\n\nStreaming the real answer.` }],
    });
    expect(leaks(out)).toBe(false);
    expect(out).toContain("Streaming the real answer");
  });
});

// Resume-path leak regression (2026-07-19): queueReminder-injected nudges
// (Large-change checkpoint, Background task truth) are role:"meta" messages.
// They must never be persisted (main.ts onMessageAppend skips meta) AND must
// never render even if present in agent.messages when the transcript is
// rebuilt — the task-wake leak taught us to lock both layers.
describe("meta reminder resume-path leak", () => {
  it("never renders role:meta messages when reconstructing a transcript", async () => {
    const { reconstructDisplayMessages } = await import("../tui-ink/app.js");
    const messages = [
      { role: "user", content: "把所有工具的描述补全" },
      {
        role: "meta",
        kind: "system-reminder",
        content: "<system-reminder>\nLarge-change checkpoint: you have read 9 files this turn...\n</system-reminder>",
      },
      { role: "assistant", content: "开始处理。" },
    ] as any;

    const display = reconstructDisplayMessages(messages);
    const rendered = JSON.stringify(display);
    expect(rendered).not.toContain("Large-change checkpoint");
    expect(display.filter((m) => m.role === "user")).toHaveLength(1);
    expect(display.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("sanitizer patterns cover the new nudge phrases for echoed references", async () => {
    const { sanitizeInternalReminderBlocks } = await import("../agent/internal-reminder-sanitizer.js");
    // An assistant echoing the wrapped block gets it stripped entirely.
    const echoed = "<bubble_internal_reminder kind=\"system-reminder\">\nLarge-change checkpoint: ...\ndelegation only adds merge risk\n</bubble_internal_reminder>\n\n真正的回答。";
    const clean = sanitizeInternalReminderBlocks(echoed);
    expect(clean).not.toContain("Large-change checkpoint");
    expect(clean).toContain("真正的回答");
  });
});
