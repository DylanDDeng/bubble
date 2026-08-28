import { describe, expect, it } from "vitest";
import {
  appendFileBlocks,
  extractFileOps,
  mergeFileOps,
  parseFileBlocks,
  stripFileBlocks,
} from "../context/compaction-files.js";
import { compactCurrentTurnToolGroups, compactMessages } from "../context/compact.js";
import { compactWithLLM } from "../context/llm-compactor.js";
import { Agent } from "../agent.js";
import type { Message, Provider } from "../types.js";

let callCounter = 0;

/** Assistant message plus matching successful tool results (unique call ids). */
function toolTurn(
  calls: Array<{ name: string; args: Record<string, unknown>; failed?: boolean }>,
): Message[] {
  const toolCalls = calls.map((call) => ({
    id: `call_${callCounter++}`,
    name: call.name,
    arguments: JSON.stringify(call.args),
  }));
  const assistant: Message = { role: "assistant", content: "", toolCalls };
  const results: Message[] = toolCalls.map((toolCall, index) => ({
    role: "tool",
    toolCallId: toolCall.id,
    content: calls[index].failed ? "Error: rejected" : "ok",
    ...(calls[index].failed ? { isError: true } : {}),
  }));
  return [assistant, ...results];
}

describe("compaction file tracking", () => {
  it("extracts read and modified paths from successful tool calls only", () => {
    const ops = extractFileOps([
      ...toolTurn([
        { name: "read", args: { path: "src/a.ts" } },
        { name: "edit", args: { path: "src/b.ts" } },
        { name: "write", args: { path: "src/c.ts", content: "x" } },
        { name: "bash", args: { command: "rm src/d.ts" } },
        { name: "read", args: {} },
        { name: "edit", args: { path: "src/rejected.ts" }, failed: true },
        { name: "read", args: { path: "src/missing.ts" }, failed: true },
      ]),
      { role: "user", content: "hi" },
    ]);

    expect(ops.read).toEqual(["src/a.ts"]);
    expect(ops.modified.sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("ignores tool calls that never got a result", () => {
    const [assistant] = toolTurn([{ name: "edit", args: { path: "src/pending.ts" } }]);
    expect(extractFileOps([assistant])).toEqual({ read: [], modified: [] });
  });

  it("round-trips blocks through append/parse/strip", () => {
    const summary = appendFileBlocks("Progress: done a thing.", {
      read: ["src/a.ts"],
      modified: ["src/b.ts"],
    });

    expect(summary).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(summary).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
    expect(parseFileBlocks(summary)).toEqual({ read: ["src/a.ts"], modified: ["src/b.ts"] });
    expect(stripFileBlocks(summary)).toBe("Progress: done a thing.");
  });

  it("sanitizes model-echoed tags so exactly one generation of blocks survives", () => {
    const echoed = "Summary.\n<read-files>\nHALLUCINATED.ts\n</read-files>\nAnd a stray <read-files> tag.";
    const appended = appendFileBlocks(echoed, { read: ["src/real.ts"], modified: [] });

    expect(appended.match(/<read-files>/g)).toHaveLength(1);
    expect(parseFileBlocks(appended)).toEqual({ read: ["src/real.ts"], modified: [] });
    expect(appended).not.toContain("HALLUCINATED.ts\n</read-files>");
  });

  it("parses multiple blocks and skips the overflow marker", () => {
    const text = "<read-files>\na.ts\n(+3 more)\n</read-files>\nmid\n<read-files>\nb.ts\n</read-files>";
    expect(parseFileBlocks(text).read.sort()).toEqual(["a.ts", "b.ts"]);
    expect(stripFileBlocks(text)).toBe("mid");
  });

  it("leaves block-free summaries byte-identical when stripping", () => {
    const summary = "Line one.\n\n\n\nLine two with odd spacing.";
    expect(stripFileBlocks(summary)).toBe(summary);
  });

  it("caps oversized lists with an explicit overflow marker", () => {
    const paths = Array.from({ length: 250 }, (_, index) => `src/f${String(index).padStart(3, "0")}.ts`);
    const summary = appendFileBlocks("S", { read: paths, modified: [] });

    expect(summary).toContain("(+50 more)");
    expect(parseFileBlocks(summary).read).toHaveLength(200);
  });

  it("merges cumulatively with normalization; modified wins over read", () => {
    const merged = mergeFileOps(
      { read: ["./src/z.ts", "src/shared.ts"], modified: ["src/old.ts"] },
      { read: ["src/a.ts"], modified: ["src//shared.ts"] },
    );

    expect(merged.read).toEqual(["src/a.ts", "src/z.ts"]);
    expect(merged.modified).toEqual(["src/old.ts", "src/shared.ts"]);
  });

  it("carries prior lists through compactWithLLM and unions the evicted ops", async () => {
    const provider = {
      complete: async () => "New rolled summary.",
    } as unknown as Provider;

    const priorSummary = appendFileBlocks("Previous conversation summary:\nOld progress.", {
      read: ["src/earlier.ts"],
      modified: ["src/done.ts"],
    });
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "meta", kind: "compaction-summary", content: priorSummary } as Message,
      { role: "user", content: "please continue the task" },
      ...toolTurn([{ name: "edit", args: { path: "src/now.ts" } }]),
      ...toolTurn([{ name: "read", args: { path: "src/keep-1.ts" } }]),
      ...toolTurn([{ name: "read", args: { path: "src/keep-2.ts" } }]),
      ...toolTurn([{ name: "read", args: { path: "src/keep-3.ts" } }]),
    ];

    const result = await compactWithLLM(messages, {
      provider,
      modelId: "test-model",
      keepRecentGroups: 2,
    });

    expect(result.compacted).toBe(true);
    const summaryMessage = result.messages!.find(
      (message) => message.role === "meta" && typeof message.content === "string" && message.content.includes("New rolled summary."),
    );
    expect(summaryMessage).toBeDefined();
    const ops = parseFileBlocks(summaryMessage!.content as string);
    // Prior lists survive; evicted ops (the edit + the first read group) join
    // them; kept-group reads stay out because their tool calls remain verbatim
    // in history.
    expect(ops.read).toEqual(["src/earlier.ts", "src/keep-1.ts"]);
    expect(ops.modified).toEqual(["src/done.ts", "src/now.ts"]);
    expect(ops.read).not.toContain("src/keep-2.ts");
    expect(ops.read).not.toContain("src/keep-3.ts");
  });

  it("keeps the blocks alive through the heuristic compactMessages path", () => {
    const priorSummary = appendFileBlocks("Previous conversation summary:\nOld.", {
      read: ["src/prior.ts"],
      modified: [],
    });
    const turn = (text: string, path: string): Message[] => [
      { role: "user", content: text },
      ...toolTurn([{ name: "edit", args: { path } }]),
      { role: "assistant", content: "done" },
    ];
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "meta", kind: "compaction-summary", content: priorSummary } as Message,
      ...turn("task one", "src/one.ts"),
      ...turn("task two", "src/two.ts"),
      ...turn("task three", "src/three.ts"),
      ...turn("task four", "src/four.ts"),
    ];

    const result = compactMessages(messages, { keepRecentTurns: 2 });

    expect(result.compacted).toBe(true);
    const ops = parseFileBlocks(result.summary!);
    expect(ops.read).toEqual(["src/prior.ts"]);
    expect(ops.modified).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("hands the block-carrying summary to onCompactionApplied for persistence", async () => {
    const persisted: string[] = [];
    const provider = {
      complete: async () => "Overflow recovery summary.",
    } as unknown as Provider;
    const agent = new Agent({
      provider,
      model: "test-model",
      tools: [],
      onCompactionApplied: (summary) => persisted.push(summary),
    });
    const turn = (text: string, path: string): Message[] => [
      { role: "user", content: text },
      ...toolTurn([{ name: "edit", args: { path } }]),
      { role: "assistant", content: "done" },
    ];
    agent.messages = [
      { role: "system", content: "system prompt" },
      ...turn("one", "src/one.ts"),
      ...turn("two", "src/two.ts"),
      ...turn("three", "src/three.ts"),
      ...turn("four", "src/four.ts"),
    ];

    // First recovery keeps two recent turns; the second is intentionally more
    // aggressive and keeps one.
    await (agent as unknown as { recoverFromOverflow(attempt: number): Promise<number> }).recoverFromOverflow(0);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain("Overflow recovery summary.");
    const ops = parseFileBlocks(persisted[0]);
    expect(ops.modified).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("records evicted sub-turn file ops on the sub-turn summary", () => {
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "inspect the project" },
      ...toolTurn([{ name: "read", args: { path: "src/evicted-1.ts" } }]),
      ...toolTurn([{ name: "edit", args: { path: "src/evicted-2.ts" } }]),
      ...toolTurn([{ name: "read", args: { path: "src/kept-1.ts" } }]),
      ...toolTurn([{ name: "read", args: { path: "src/kept-2.ts" } }]),
    ];

    const result = compactCurrentTurnToolGroups(messages, { keepRecentGroups: 2 });

    expect(result.compacted).toBe(true);
    const summaryMessage = result.messages!.find(
      (message) => message.role === "meta" && (message as { kind?: string }).kind === "subturn-compaction-summary",
    );
    const ops = parseFileBlocks(summaryMessage!.content as string);
    expect(ops.read).toEqual(["src/evicted-1.ts"]);
    expect(ops.modified).toEqual(["src/evicted-2.ts"]);
    expect(ops.read).not.toContain("src/kept-1.ts");
  });
});
