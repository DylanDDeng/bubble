import { describe, expect, it, vi } from "vitest";
import { compactWithLLM, LLM_SUMMARY_PREFIX } from "../context/llm-compactor.js";
import type { Message, Provider } from "../types.js";

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
    expect(out[1].role).toBe("user");
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
