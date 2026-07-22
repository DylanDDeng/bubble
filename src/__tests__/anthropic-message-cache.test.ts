import { afterEach, describe, expect, it } from "vitest";
import { buildAnthropicRequest, placeMessageCacheBreakpoints } from "../provider-anthropic.js";
import type { ProviderMessage, ToolDefinition } from "../types.js";

// Message-region prompt-cache breakpoints. The property that matters is not
// "a cache_control appears somewhere" but that the ANCHOR of request N lands on
// the block that was the TAIL of request N-1 — that is the position where the
// previous request wrote its cache entry, and hitting it directly is what makes
// the scheme independent of Anthropic's 20-block backward lookback.

const OFFICIAL = {
  providerId: "anthropic",
  apiKey: "sk-test",
  baseURL: "https://api.anthropic.com",
};

const readTool: ToolDefinition = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

/** History after `turns` completed tool turns, each with `parallel` tool calls. */
function history(turns: number, parallel = 1): ProviderMessage[] {
  const messages: ProviderMessage[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "fix the failing test" },
  ];
  for (let turn = 0; turn < turns; turn++) {
    const toolCalls = Array.from({ length: parallel }, (_, k) => ({
      id: `t${turn}_${k}`,
      name: "read",
      arguments: JSON.stringify({ path: `src/f${k}.ts` }),
    }));
    messages.push({ role: "assistant", content: `step ${turn + 1}`, toolCalls });
    for (const call of toolCalls) {
      messages.push({ role: "tool", toolCallId: call.id, content: `contents of ${call.id}` });
    }
  }
  return messages;
}

function build(messages: ProviderMessage[], stream = true) {
  return buildAnthropicRequest(OFFICIAL, messages, {
    model: "claude-opus-4-8",
    tools: [readTool],
    stream,
  });
}

interface Marked { message: number; block: number }

function markedBlocks(body: ReturnType<typeof build>): Marked[] {
  const out: Marked[] = [];
  body.messages.forEach((message, messageIndex) => {
    if (typeof message.content === "string") return;
    message.content.forEach((block, blockIndex) => {
      if ((block as { cache_control?: unknown }).cache_control) {
        out.push({ message: messageIndex, block: blockIndex });
      }
    });
  });
  return out;
}

function blockAt(body: ReturnType<typeof build>, at: Marked): unknown {
  const content = body.messages[at.message].content;
  if (typeof content === "string") return content;
  const { cache_control: _dropped, ...rest } = content[at.block] as Record<string, unknown>;
  return rest;
}

describe("anthropic message cache breakpoints", () => {
  afterEach(() => {
    delete process.env.BUBBLE_ANTHROPIC_MESSAGE_CACHE;
  });

  it("puts the tail breakpoint on the last block of the last message", () => {
    const body = build(history(2));
    const marks = markedBlocks(body);
    const lastMessage = body.messages.at(-1)!;
    const lastBlockIndex = (lastMessage.content as unknown[]).length - 1;

    expect(marks).toContainEqual({ message: body.messages.length - 1, block: lastBlockIndex });
  });

  it("anchors request N on the block that was request N-1's tail", () => {
    // The load-bearing property. Build two consecutive requests from the same
    // growing history and check the anchor of the later one coincides with the
    // tail of the earlier one — compared by CONTENT, since cache_control itself
    // is not part of the cache key and message indices could otherwise drift.
    const previous = build(history(2));
    const current = build(history(3));

    const previousTail = markedBlocks(previous).at(-1)!;
    const currentMarks = markedBlocks(current);
    expect(currentMarks).toHaveLength(2);

    const anchor = currentMarks[0];
    expect(blockAt(current, anchor)).toEqual(blockAt(previous, previousTail));
  });

  it("holds that property when a turn emits many parallel tool calls", () => {
    // 14 parallel calls is 29 content blocks per turn, well past the 20-block
    // lookback — the regime where a fixed-distance anchor silently degrades to
    // no caching at all.
    const previous = build(history(2, 14));
    const current = build(history(3, 14));

    const previousTail = markedBlocks(previous).at(-1)!;
    const anchor = markedBlocks(current)[0];

    expect(blockAt(current, anchor)).toEqual(blockAt(previous, previousTail));
  });

  it("never exceeds Anthropic's four-breakpoint limit, counting tools and system", () => {
    const body = build(history(3));
    const toolMarks = (body.tools ?? []).filter((tool) => tool.cache_control).length;
    const systemMarks = Array.isArray(body.system)
      ? body.system.filter((block) => block.cache_control).length
      : 0;

    expect(toolMarks + systemMarks + markedBlocks(body).length).toBeLessThanOrEqual(4);
    // And the static two are still there — this change must not displace them.
    expect(toolMarks).toBe(1);
    expect(systemMarks).toBe(1);
  });

  it("drops the anchor rather than overflowing when the budget is 1", () => {
    const messages = build(history(3)).messages;
    for (const message of messages) {
      if (typeof message.content !== "string") {
        for (const block of message.content) delete (block as { cache_control?: unknown }).cache_control;
      }
    }
    expect(placeMessageCacheBreakpoints(messages, 1)).toBe(1);
    expect(placeMessageCacheBreakpoints(messages, 0)).toBe(0);
  });

  it("does not mark anything for one-shot (non-streaming) requests", () => {
    // complete() serves compaction, session titles and memory: no next turn
    // will read the entry back, so a breakpoint there is a pure 1.25x surcharge.
    expect(markedBlocks(build(history(3), false))).toEqual([]);
  });

  it("leaves non-official endpoints byte-for-byte unchanged", () => {
    const messages = history(3);
    const gateway = buildAnthropicRequest(
      { providerId: "anthropic", apiKey: "sk-test", baseURL: "https://gateway.corp.example/v1" },
      messages,
      { model: "claude-opus-4-8", tools: [readTool], stream: true },
    );
    // providerId is still "anthropic" — a corporate proxy keeps the id and only
    // changes baseURL, so the gate must key on the URL alone.
    expect(markedBlocks(gateway as ReturnType<typeof build>)).toEqual([]);
  });

  it("honours the kill switch", () => {
    process.env.BUBBLE_ANTHROPIC_MESSAGE_CACHE = "0";
    expect(markedBlocks(build(history(3)))).toEqual([]);
  });

  it("falls back to tail-only on the first turn, where no anchor exists yet", () => {
    // The system message is hoisted out of `messages`, so this projects to a
    // single user message: nothing to anchor on, but its tail still seeds the
    // entry that turn 2 will read.
    const firstTurn = build([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ]);
    expect(markedBlocks(firstTurn)).toHaveLength(1);
  });

  it("wraps a bare-string tail so a breakpoint has a block to sit on", () => {
    const body = build([
      { role: "system", content: "system prompt" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second question" },
    ]);
    const tail = body.messages.at(-1)!;
    expect(tail.content).toEqual([
      { type: "text", text: "second question", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("never marks a thinking block", () => {
    // cache_control is not permitted on thinking blocks. Thinking is stripped on
    // the official path today, so this guards the placement helper directly.
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "answer" },
          { type: "thinking" as const, thinking: "reasoning" },
        ],
      },
    ];
    placeMessageCacheBreakpoints(messages as never, 2);
    expect(messages[1].content[1]).toEqual({ type: "thinking", thinking: "reasoning" });
    expect(messages[1].content[0]).toHaveProperty("cache_control");
  });
});
