import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { compactMessages, isCompactionSummaryMessage } from "../context/compact.js";
import { LLM_SUMMARY_PREFIX } from "../context/llm-compactor.js";
import { projectMessages } from "../context/projector.js";
import type { AgentEvent, Message, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

/**
 * Full-loop regression for compaction thrash (the 0.0.42 disease: 68-75
 * compactions per benchmark run, stacking dozens of stale summaries).
 *
 * The adversarial review killed the previous unit-level assertion surface:
 * after one projection→rewrite round-trip, summaries change role/shape, so
 * counting "system messages with the summary prefix" passes while the
 * provider payload still bloats. These tests therefore assert on the FINAL
 * PROJECTED payload across the real agent loop.
 */

const SUMMARY_MARKER = "Previous conversation summary:";

function countSummaryMarkers(messages: Array<{ content: unknown }>): number {
  let count = 0;
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    count += message.content.split(SUMMARY_MARKER).length - 1;
  }
  return count;
}

function fakeReadTool(): ToolRegistryEntry {
  let call = 0;
  return {
    name: "read",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute() {
      call += 1;
      return {
        content: `FILE CONTENT ${call}\n` + "x".repeat(12000),
        isError: false,
        metadata: { kind: "read", path: `/repo/file${call}.ts` },
      };
    },
  } as unknown as ToolRegistryEntry;
}

function readCallTurn(turn: number): StreamChunk[] {
  return [
    { type: "text", content: `analysis for step ${turn} ` + "y".repeat(400) },
    { type: "tool_call", id: `r${turn}`, name: "read", arguments: "", isStart: true, isEnd: false },
    { type: "tool_call", id: `r${turn}`, name: "read", arguments: "", argumentsFull: `{"path":"/repo/file${turn}.ts"}`, isStart: false, isEnd: true },
    { type: "done" },
  ];
}

async function drain(iterable: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const _event of iterable) { /* consume */ }
}

describe("compaction full-loop invariants", () => {
  it("never touches resident history below the context cliff (anti-amnesia)", async () => {
    // The re-read death loop: mid-run trimming stole the model's working
    // memory, so it re-read the same files over and over. Below the cliff
    // (75% of the context window), every tool result must survive verbatim.
    const TURNS = 10;
    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        const chunks = calls <= TURNS
          ? readCallTurn(calls)
          : [{ type: "text", content: "final answer" } as StreamChunk, { type: "done" } as StreamChunk];
        for (const chunk of chunks) yield chunk;
      },
      async complete() {
        return "should never be asked to summarize below the cliff";
      },
    };

    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [fakeReadTool()],
      systemPrompt: "system prompt for the below-cliff test",
    });

    await drain(agent.run("read ten files", process.cwd()));

    const stats = agent.getCompactionStats();
    expect(stats.fired).toBe(0);
    // Every read result is still resident, in full - nothing folded, nothing
    // summarized, nothing replaced by an "output omitted" stub.
    const toolContents = agent.messages
      .filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool")
      .map((m) => m.content);
    expect(toolContents).toHaveLength(TURNS);
    for (const content of toolContents) {
      expect(content).toContain("FILE CONTENT");
      expect(content).not.toContain("omitted");
    }
    expect(agent.messages.some((m) => isCompactionSummaryMessage(m as Message))).toBe(false);
  });

  it("keeps at most one summary in the projected payload across an 80-turn single-instruction run", async () => {
    const TURNS = 80;
    let calls = 0;
    const provider: Provider = {
      async *streamChat() {
        calls += 1;
        const chunks = calls <= TURNS
          ? readCallTurn(calls)
          : [{ type: "text", content: "all done" } as StreamChunk, { type: "done" } as StreamChunk];
        for (const chunk of chunks) yield chunk;
      },
      async complete() {
        // The LLM compaction path may fire; return a deterministic summary.
        return "merged summary of earlier work";
      },
    };

    const instruction = `Implement the feature. ${"Spec detail sentence. ".repeat(40)}FINAL_REQUIREMENT_MARKER: archive results when done.`;
    const agent = new Agent({
      provider,
      providerId: "openai",
      model: "openai:gpt-4o",
      tools: [fakeReadTool()],
      systemPrompt: "system prompt for the loop test",
    });

    await drain(agent.run(instruction, process.cwd()));

    // Invariant 1: at most one summary marker in the resident history...
    const residentSummaries = agent.messages.filter((m) => isCompactionSummaryMessage(m as Message));
    expect(residentSummaries.length).toBeLessThanOrEqual(1);
    expect(countSummaryMarkers(agent.messages)).toBeLessThanOrEqual(1);

    // ...and in the projected provider payload, including content fused into
    // the first system message (the legacy failure mode).
    const projected = projectMessages(agent.messages as Message[], { mode: "pruned" });
    expect(countSummaryMarkers(projected)).toBeLessThanOrEqual(1);

    // Invariant 2: the original instruction (with its late requirement)
    // survives verbatim in the projected payload.
    expect(projected.some((m) =>
      typeof m.content === "string" && m.content.includes("FINAL_REQUIREMENT_MARKER"))).toBe(true);

    // Invariant 3: compaction is a low-frequency event, not a per-turn one.
    const stats = agent.getCompactionStats();
    const written = stats.resident + stats.subturn + stats.llm;
    // The run must actually exercise compaction for these invariants to mean
    // anything — 80 turns of 12KB tool traffic crosses the 75% cliff of
    // gpt-4o's 128k window (the only remaining trigger; the early message-
    // count and char-size thresholds were removed: below the cliff, history
    // is never touched).
    expect(stats.fired).toBeGreaterThan(0);
    expect(stats.fired).toBeLessThanOrEqual(TURNS / 4);
    expect(written).toBeLessThanOrEqual(stats.fired);
  }, 30_000);

  it("repeated turn-level compaction never stacks summaries or grows history (direct loop)", () => {
    let messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "the original ask with TAIL_MARKER at the end" },
    ];
    let previousChars = Number.POSITIVE_INFINITY;
    let fires = 0;

    for (let round = 1; round <= 15; round++) {
      messages.push({ role: "user", content: `follow-up ${round}` });
      for (let i = 0; i < 3; i++) {
        messages.push({ role: "assistant", content: `work r${round}.${i} ` + "z".repeat(600) });
      }
      const result = compactMessages(messages, { keepRecentTurns: 2 });
      if (result.compacted && result.messages) {
        messages = result.messages as Message[];
        fires += 1;
        const summaries = messages.filter((m) => isCompactionSummaryMessage(m));
        expect(summaries).toHaveLength(1);
        const chars = messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0), 0);
        // Compacted history stays bounded instead of growing round over round.
        expect(chars).toBeLessThanOrEqual(Math.max(previousChars, 12_000));
        previousChars = chars;
      }
    }
    expect(fires).toBeGreaterThan(0);
    // The pinned original ask is still alive verbatim after every fold.
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("TAIL_MARKER"))).toBe(true);
  });

  it("locks the llm-compactor envelope prefix to the literal compact.ts matches", () => {
    // compact.ts cannot import LLM_SUMMARY_PREFIX (module cycle), so it
    // matches a literal prefix. This test keeps the two in sync.
    expect(LLM_SUMMARY_PREFIX.startsWith("Another language model previously worked on this task")).toBe(true);
  });

  it("strips legacy stacked summaries from ≤0.0.42 sessions on the next compaction", () => {
    const legacyStack: Message[] = [
      { role: "system", content: "sys" },
      { role: "system", content: `${SUMMARY_MARKER}\nstale summary one` },
      { role: "system", content: `${SUMMARY_MARKER}\nstale summary two` },
      { role: "user", content: "original ask" },
      { role: "user", content: `<bubble_internal_context kind="runtime-system">\n${SUMMARY_MARKER}\nstale projected summary\n</bubble_internal_context>` },
      { role: "assistant", content: "w1" },
      { role: "user", content: "second ask" },
      { role: "assistant", content: "w2" },
      { role: "user", content: "third ask" },
      { role: "assistant", content: "w3" },
      { role: "user", content: "fourth ask" },
      { role: "assistant", content: "w4" },
    ];

    const result = compactMessages(legacyStack, { keepRecentTurns: 2 });
    expect(result.compacted).toBe(true);
    expect(countSummaryMarkers(result.messages!)).toBe(1);
  });
});
