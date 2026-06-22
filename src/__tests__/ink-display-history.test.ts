import { describe, expect, it } from "vitest";
import {
  appendTextPart,
  appendToolPart,
  compactDisplayMessages as compactInkDisplayMessages,
  contentFromParts,
  moveStatusMessageToEnd,
  snapshotDisplayParts,
  stripInterruptedAssistantMarker,
  toolCallsFromParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
} from "../tui-ink/display-history.js";
import {
  compactDisplayMessages as compactLegacyDisplayMessages,
  type DisplayMessage as LegacyDisplayMessage,
} from "../tui/display-history.js";

describe("Ink display history parts", () => {
  it("preserves assistant text/tool timeline order", () => {
    const parts: DisplayMessagePart[] = [];
    const read = tool("read", { path: "a.ts" }, "line 1");
    const bash = tool("bash", { command: "npm test" }, "ok");

    appendTextPart(parts, "Let me inspect first.");
    appendToolPart(parts, read);
    appendTextPart(parts, "Now I will verify.");
    appendToolPart(parts, bash);

    expect(parts).toEqual([
      { type: "text", content: "Let me inspect first." },
      { type: "tools", toolCalls: [read] },
      { type: "text", content: "Now I will verify." },
      { type: "tools", toolCalls: [bash] },
    ]);
    expect(contentFromParts(parts)).toBe("Let me inspect first.Now I will verify.");
    expect(toolCallsFromParts(parts)).toEqual([read, bash]);
  });

  it("coalesces adjacent text and adjacent tools", () => {
    const parts: DisplayMessagePart[] = [];
    const first = tool("read", { path: "a.ts" });
    const second = tool("read", { path: "b.ts" });

    appendTextPart(parts, "hello");
    appendTextPart(parts, " world");
    appendToolPart(parts, first);
    appendToolPart(parts, second);

    expect(parts).toEqual([
      { type: "text", content: "hello world" },
      { type: "tools", toolCalls: [first, second] },
    ]);
  });

  it("snapshots parts so later streaming mutations do not rewrite history", () => {
    const parts: DisplayMessagePart[] = [];
    const read = tool("read", { path: "a.ts" });

    appendToolPart(parts, read);
    const snapshot = snapshotDisplayParts(parts);
    read.args.path = "b.ts";
    read.result = "mutated";

    expect(snapshot).toEqual([
      { type: "tools", toolCalls: [tool("read", { path: "a.ts" }, undefined, { id: read.id })] },
    ]);
  });

  it("moves an applied steer placeholder after the committed assistant turn", () => {
    const messages: DisplayMessage[] = [
      { key: "first-user", role: "user", content: "first" },
      { key: "steer", role: "user", content: "steer", inputStatus: "pending_steer" },
      {
        key: "tool-turn",
        role: "assistant",
        content: "",
        parts: [{ type: "tools", toolCalls: [tool("bash", { command: "ls" }, "ok")] }],
      },
    ];

    expect(moveStatusMessageToEnd(messages, "steer").map((message) => ({
      key: message.key,
      inputStatus: message.inputStatus,
    }))).toEqual([
      { key: "first-user", inputStatus: undefined },
      { key: "tool-turn", inputStatus: undefined },
      { key: "steer", inputStatus: undefined },
    ]);
  });

  it("keeps old part text verbatim and collapses tool result bodies", () => {
    const diff = [
      "--- a/file-0.ts",
      "+++ b/file-0.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const messages: DisplayMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant",
      content: `assistant ${index} ${"x".repeat(1800)}`,
      parts: [
        { type: "text", content: `text ${index} ${"y".repeat(1800)}` },
        {
          type: "tools",
          toolCalls: [
            tool("edit", { path: `file-${index}.ts` }, `Edited file\n\nDiff:\n${diff}\n${"z".repeat(2400)}`, {
              metadata: { kind: "edit", path: `file-${index}.ts`, diff },
            }),
          ],
        },
      ],
    }));

    const compacted = compactInkDisplayMessages(messages);

    const oldText = compacted[0].parts?.find((part) => part.type === "text");
    const oldTools = compacted[0].parts?.find((part) => part.type === "tools");
    // a1aeb19 parity: what the assistant said is never rewritten — only bulky
    // tool-result bodies collapse on old messages.
    expect(oldText?.type === "text" ? oldText.content : "").toBe(
      messages[0].parts?.[0].type === "text" ? messages[0].parts[0].content : "",
    );
    const oldTool = oldTools?.type === "tools" ? oldTools.toolCalls[0] : undefined;
    expect(oldTool?.result).toBeUndefined();
    expect(oldTool?.resultCollapsed).toBe(true);
    expect(oldTool?.metadata?.diff).toBe(diff);
    expect(JSON.stringify(oldTool)).not.toContain("✂");
    expect(JSON.stringify(oldTool)).not.toContain("chars omitted for UI");

    const recent = compacted.at(-1)!;
    expect(recent.parts).toEqual(messages.at(-1)!.parts);
  });

  const displayHistoryCompactors: Array<[string, (messages: any[]) => any[]]> = [
    ["legacy", compactLegacyDisplayMessages],
    ["ink", compactInkDisplayMessages],
  ];

  it.each(displayHistoryCompactors)("collapses old tool result bodies for %s display history", (_name, compact) => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant" as const,
      content: `assistant ${index}`,
      toolCalls: [
        tool("read", { path: `file-${index}.ts` }, `line ${index}\n${"z".repeat(2400)}`),
      ],
    }));

    const compacted = compact(messages);

    expect(compacted[0].toolCalls?.[0].result).toBeUndefined();
    expect(compacted[0].toolCalls?.[0].resultCollapsed).toBe(true);
    expect(JSON.stringify(compacted[0].toolCalls?.[0])).not.toContain("✂");
    expect(compacted.at(-1)?.toolCalls?.[0].result).toBe(messages.at(-1)?.toolCalls[0].result);
    expect(compacted.at(-1)?.toolCalls?.[0].resultCollapsed).toBeUndefined();
  });

  it("never truncates message text in the legacy display history", () => {
    const longPrompt = `请使用 Three.js 开发一个 3D 网页。${"要求很多很多。".repeat(400)}`;
    const messages: LegacyDisplayMessage[] = [
      { role: "user", content: longPrompt },
      ...Array.from({ length: 40 }, (_, index) => ({
        role: "assistant" as const,
        content: `assistant ${index} ${"x".repeat(3000)}`,
        reasoning: `thinking ${index} ${"r".repeat(2000)}`,
      })),
    ];

    const compacted = compactLegacyDisplayMessages(messages);

    expect(compacted[0].content).toBe(longPrompt);
    expect(compacted[1].content).toBe(messages[1].content);
    expect(compacted[1].reasoning).toBe(messages[1].reasoning);
    expect(JSON.stringify(compacted)).not.toContain("✂");
  });

  it("folds overflow history behind a single summary card in the legacy display history", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index} ${"x".repeat(500)}`,
    }));

    const compacted = compactLegacyDisplayMessages(messages);

    const card = compacted[0];
    expect(card.syntheticKind).toBe("ui_compact_card");
    expect(card.hiddenCount).toBe(20);
    expect(card.compactionMeta?.messages).toBe(20);
    expect(card.compactionMeta?.turns).toBe(10);
    expect(card.content).not.toContain("tokens");

    const visible = compacted.slice(1);
    expect(visible).toHaveLength(80);
    expect(visible[0].content).toBe(messages[20].content);
    expect(visible.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(JSON.stringify(visible)).not.toContain("✂");
  });

  it("strips the model-facing interruption note from aborted assistant content", () => {
    const marker =
      "Interrupted by user. The prior request was stopped and should not be resumed unless the user asks.";

    // Marker-only content (interrupt before any streamed text) → nothing left.
    expect(stripInterruptedAssistantMarker(marker, marker)).toBe("");
    // Partial streamed text survives; only the appended note goes away.
    expect(stripInterruptedAssistantMarker(`I was saying…\n\n${marker}`, marker)).toBe("I was saying…");
    // Unrelated content is untouched, even if it mentions interruptions.
    expect(stripInterruptedAssistantMarker("All done.", marker)).toBe("All done.");
    expect(stripInterruptedAssistantMarker(`${marker} trailing`, marker)).toBe(`${marker} trailing`);
  });

  it("keeps all display messages available for app-level scrolling", () => {
    const messages: DisplayMessage[] = Array.from({ length: 100 }, (_, index) => ({
      key: `msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(200)}`,
    }));

    const compacted = compactInkDisplayMessages(messages);

    expect(compacted).toHaveLength(100);
    expect(compacted[0].syntheticKind).toBeUndefined();
    expect(compacted.at(-1)?.content).toBe(messages.at(-1)?.content);
  });
});

function tool(
  name: string,
  args: Record<string, unknown>,
  result?: string,
  extra: Partial<DisplayToolCall> = {},
): DisplayToolCall {
  return {
    id: `${name}:${JSON.stringify(args)}`,
    name,
    args,
    result,
    ...extra,
  };
}
