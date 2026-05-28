import { describe, expect, it } from "vitest";
import {
  appendTextPart,
  appendToolPart,
  compactDisplayMessages as compactInkDisplayMessages,
  contentFromParts,
  snapshotDisplayParts,
  toolCallsFromParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
} from "../tui-ink/display-history.js";
import { compactDisplayMessages as compactLegacyDisplayMessages } from "../tui/display-history.js";
import { compactDisplayMessages as compactOpenTuiDisplayMessages } from "../tui-opentui/display-history.js";
import { isWritePreviewTool } from "../tui/tool-renderers/write-preview.js";

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

  it("compacts old part text and collapses tool result bodies", () => {
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
    expect(oldText?.type === "text" ? oldText.content.length : 0).toBeLessThan(
      messages[0].parts?.[0].type === "text" ? messages[0].parts[0].content.length : Infinity,
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
    ["opentui", compactOpenTuiDisplayMessages],
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

  it("does not render collapsed write tools through the write-preview renderer", () => {
    const collapsedWrite = tool("write", { path: "a.ts", content: "x".repeat(1000) }, undefined, {
      resultCollapsed: true,
    });

    expect(isWritePreviewTool(collapsedWrite)).toBe(false);
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
