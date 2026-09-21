import { describe, expect, it, vi } from "vitest";
import { compactWithLLM, LLM_SUMMARY_PREFIX } from "../context/llm-compactor.js";
import type { Message, Provider } from "../types.js";
import { estimateTextTokens, getMaxInputTokens } from "../context/budget.js";
import { getModelContextWindow } from "../model-catalog.js";

function makeProvider(completeImpl: Provider["complete"]): Provider {
  return {
    async *streamChat() {
      // unused
    },
    complete: completeImpl,
  };
}

function group(callId: string, toolName: string, args: Record<string, unknown>, resultText: string): Message[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: callId, name: toolName, arguments: JSON.stringify(args) }],
    },
    { role: "tool", toolCallId: callId, content: resultText },
  ];
}

describe("compactWithLLM", () => {
  it("fits a small CJK window while protecting old summaries and user constraints", async () => {
    const complete = vi.fn(async () => "保留原始约束和已有决定。");
    const history: Message[] = [
      { role: "user", content: "first instruction" },
      { role: "meta", kind: "compaction-summary", content: "OLD_DECISION: 禁止修改公开接口" },
      ...group("old", "read", {}, "中文数据".repeat(1000)),
      { role: "user", content: "EARLIER_CONSTRAINT: 保留兼容性" },
      ...group("recent", "read", {}, "最近的发现"),
      { role: "user", content: "latest request" },
      ...group("kept", "read", {}, "kept tool result"),
    ];
    const result = await compactWithLLM(history, {
      provider: makeProvider(complete), modelId: "fake", contextWindow: 1024,
    });
    expect(result.compacted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const input = (complete.mock.calls as unknown as [Array<{ content: string }>][])[0][0];
    const sent = input[1].content;
    expect(sent).toContain("OLD_DECISION");
    expect(sent).toContain("EARLIER_CONSTRAINT");
    expect(sent).not.toContain("TOOL_CALL[read]: {}\n\nTOOL_RESULT[read]: 中文数据");
    expect(sent).toContain("最近的发现");
    expect(result.degradation).toContain("omitted 1");
    expect(result.summary).toContain(result.degradation);
    expect(Math.ceil((input.reduce((n, m) => n + estimateTextTokens(m.content), 0) + 32) * 1.25))
      .toBeLessThanOrEqual(1024 - 256 - 64);
    expect(result.messages!.slice(-3)).toEqual(history.slice(-3));
  });

  it("uses the catalog window when providerId is supplied", async () => {
    const complete = vi.fn(async () => "summary");
    const history: Message[] = [
      { role: "user", content: "first" },
      ...group("old", "read", {}, "x".repeat(40_000)),
      { role: "user", content: "last" },
    ];
    const result = await compactWithLLM(history, {
      provider: makeProvider(complete), providerId: "openai", modelId: "openai:gpt-4o",
    });
    expect(result.compacted).toBe(true);
    expect(result.degradation).toBeUndefined();
    const input = (complete.mock.calls as unknown as [Array<{ content: string }>][])[0][0];
    expect(input[1].content).toContain("x".repeat(40_000));
    expect(input.reduce((n, m) => n + estimateTextTokens(m.content, "openai"), 0))
      .toBeLessThan(getMaxInputTokens(getModelContextWindow("openai", "gpt-4o"))!);
  });

  it("fails without calling rather than dropping an oversized previous summary", async () => {
    const complete = vi.fn(async () => "should not be called");
    const result = await compactWithLLM([
      { role: "meta", kind: "compaction-summary", content: "约束".repeat(2000) },
      { role: "user", content: "current" },
    ], { provider: makeProvider(complete), modelId: "fake", contextWindow: 1024 });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("cannot retain prior summaries");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not call on an empty transcript after input budget degradation", async () => {
    const complete = vi.fn(async () => "should not be called");
    const result = await compactWithLLM([
      { role: "user", content: "first" },
      ...group("huge", "read", {}, "汉".repeat(10_000)),
      { role: "user", content: "last" },
    ], { provider: makeProvider(complete), modelId: "fake", contextWindow: 1024 });
    expect(result.compacted).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects cancellation even if the provider resolves (pre-aborted=%s)", async (preAborted) => {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const complete = vi.fn(async () => { controller.abort(); return "late result"; });
    const history: Message[] = [
      { role: "user", content: "first" }, { role: "assistant", content: "work" },
      { role: "user", content: "last" },
    ];
    const snapshot = structuredClone(history);
    const result = await compactWithLLM(history, {
      provider: makeProvider(complete), modelId: "fake", abortSignal: controller.signal,
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("cancelled");
    expect(complete).toHaveBeenCalledTimes(preAborted ? 0 : 1);
    expect(history).toEqual(snapshot);
  });

  it.each(["中".repeat(101), "<read-files>\nfake.ts\n</read-files>"])("rejects oversized or markup-only output", async (output) => {
    const result = await compactWithLLM([
      { role: "user", content: "first" }, { role: "assistant", content: "work" },
      { role: "user", content: "last" },
    ], { provider: makeProvider(async () => output), modelId: "fake", maxOutputTokens: 100 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toBeUndefined();
  });

  it("summarizes everything before the last user message in a single-turn conversation", async () => {
    const provider = makeProvider(vi.fn(async () => "Read 5 game files; mostly pygame + HTML canvas demos."));
    const history: Message[] = [
      { role: "system", content: "sys prompt" },
      { role: "user", content: "look at this project" },
      ...group("a", "read", { file_path: "/a.html" }, "x".repeat(2000)),
      ...group("b", "read", { file_path: "/b.html" }, "y".repeat(2000)),
      ...group("c", "read", { file_path: "/c.html" }, "z".repeat(2000)),
    ];

    const result = await compactWithLLM(history, { provider, modelId: "fake" });

    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("pygame");

    const out = result.messages!;
    // Prefix-cache invariant: system/meta preserved in original order at the start.
    expect(out[0]).toMatchObject({ role: "system", content: "sys prompt" });
    // Summary inserted as user-role envelope (not a new system message).
    expect(out[1]).toMatchObject({ role: "meta", kind: "compaction-summary" });
    expect((out[1] as { content: string }).content).toContain(LLM_SUMMARY_PREFIX);
    expect((out[1] as { content: string }).content).toContain("pygame");
    // Original last user ask preserved verbatim right after the summary.
    expect(out[2]).toMatchObject({ role: "user", content: "look at this project" });
    // Kept tool groups follow. With keepRecentGroups=2 (default) and 3 groups
    // in input, the last 2 (b,c) should remain — 4 messages (2 assistant + 2 tool).
    expect(out.slice(3).map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
    // Total length collapsed (was 8 messages, now should be 7: system + summary + user + 4 kept).
    expect(out.length).toBeLessThan(history.length);
  });

  it("returns compacted=false when there's no user message to anchor the compaction", async () => {
    const provider = makeProvider(vi.fn(async () => "summary"));
    const result = await compactWithLLM([{ role: "system", content: "sys" }], {
      provider,
      modelId: "fake",
    });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("no user message");
  });

  it("returns compacted=false when there's nothing to evict", async () => {
    const provider = makeProvider(vi.fn(async () => "summary"));
    const result = await compactWithLLM(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "first ask" },
      ],
      { provider, modelId: "fake" },
    );
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("nothing to evict");
  });

  it("returns compacted=false and the provider's error reason when the model call fails", async () => {
    const provider = makeProvider(async () => {
      throw new Error("rate limited");
    });
    const history: Message[] = [
      { role: "user", content: "earlier task" },
      { role: "assistant", content: "did earlier work" },
      { role: "user", content: "current ask" },
    ];

    const result = await compactWithLLM(history, { provider, modelId: "fake" });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("rate limited");
  });

  it("returns compacted=false when the provider returns an empty summary", async () => {
    const provider = makeProvider(async () => "   ");
    const history: Message[] = [
      { role: "user", content: "earlier task" },
      { role: "assistant", content: "did earlier work" },
      { role: "user", content: "current ask" },
    ];

    const result = await compactWithLLM(history, { provider, modelId: "fake" });
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("empty summary");
  });

  it("trims oldest items first when input would otherwise exceed the model's input budget", async () => {
    const capturedInputs: string[] = [];
    const provider = makeProvider(async (msgs) => {
      // Capture what was actually sent for summarization.
      const userMsg = msgs.find((m) => m.role === "user");
      if (userMsg && typeof userMsg.content === "string") capturedInputs.push(userMsg.content);
      return "trimmed-summary";
    });

    // 20 groups, each ~3KB, plus history; total well above maxInputTokens=2000.
    const ballast = "x".repeat(3000);
    const olderGroups: Message[] = [];
    for (let i = 0; i < 20; i++) olderGroups.push(...group(`g${i}`, "read", { file_path: `/f${i}` }, ballast));

    const history: Message[] = [{ role: "user", content: "scan" }, ...olderGroups, { role: "user", content: "now" }];
    const result = await compactWithLLM(history, {
      provider,
      modelId: "fake",
      maxInputTokens: 2000,
    });

    expect(result.compacted).toBe(true);
    // The text we sent to the summarizer must be smaller than the un-trimmed equivalent.
    const sentLen = capturedInputs[0]?.length ?? 0;
    const fullSerialized = olderGroups.reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    expect(sentLen).toBeLessThan(fullSerialized);
  });
});
