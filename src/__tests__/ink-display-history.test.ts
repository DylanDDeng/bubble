import { describe, expect, it } from "vitest";
import {
  appendTextPart,
  appendToolPart,
  compactDisplayMessages,
  contentFromParts,
  snapshotDisplayParts,
  toolCallsFromParts,
  type DisplayMessage,
  type DisplayMessagePart,
  type DisplayToolCall,
} from "../tui-ink/display-history.js";

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

  it("compacts old part text and tool results", () => {
    const messages: DisplayMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant",
      content: `assistant ${index} ${"x".repeat(1800)}`,
      parts: [
        { type: "text", content: `text ${index} ${"y".repeat(1800)}` },
        {
          type: "tools",
          toolCalls: [
            tool("read", { path: `file-${index}.ts` }, `result ${index}\n${"z".repeat(2400)}`),
          ],
        },
      ],
    }));

    const compacted = compactDisplayMessages(messages);

    const oldText = compacted[0].parts?.find((part) => part.type === "text");
    const oldTools = compacted[0].parts?.find((part) => part.type === "tools");
    expect(oldText?.type === "text" ? oldText.content.length : 0).toBeLessThan(
      messages[0].parts?.[0].type === "text" ? messages[0].parts[0].content.length : Infinity,
    );
    expect(oldTools?.type === "tools" ? oldTools.toolCalls[0].result?.length : 0).toBeLessThan(
      messages[0].parts?.[1].type === "tools" ? messages[0].parts[1].toolCalls[0].result?.length ?? Infinity : Infinity,
    );

    const recent = compacted.at(-1)!;
    expect(recent.parts).toEqual(messages.at(-1)!.parts);
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
