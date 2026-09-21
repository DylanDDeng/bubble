import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistoryDivergedError, SessionManager } from "../session.js";
import { SessionContextFence } from "../session-context-fence.js";
import { capPayload, fitSummaryInput } from "../context/llm-compactor.js";
import type { Message } from "../types.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-pr76-r2-"));
  dirs.push(dir);
  const session = new SessionManager(join(dir, "session.jsonl"));
  session.appendMessage({ role: "user", content: "original" });
  session.appendMessage({ role: "assistant", content: "ack" });
  return { session, reopen: () => new SessionManager(session.getSessionFile()) };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** Legacy `summary` records are read-only history: no production code writes
 * them any more, so tests seed one the way an old build left it on disk. */
function seedLegacySummary(file: string, summary: string): void {
  appendFileSync(file, JSON.stringify({ id: "legacy-summary", type: "summary", summary, timestamp: Date.now() }) + "\n");
}

describe("PR76 round-2: fence rejection reloads resident history", () => {
  it("rejects a stale append with the typed divergence error", () => {
    const { session, reopen } = fixture();
    const staleRevision = session.getRevision();
    reopen().appendMessage({ role: "user", content: "foreign instruction" });
    try {
      session.appendMessage({ role: "assistant", content: "stale answer" }, staleRevision);
      expect.unreachable("stale append must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionHistoryDivergedError);
      expect((error as Error).message).toBe("Session changed during active turn; reload before committing context");
    }
    expect(reopen().getMessages().some(m => m.role === "assistant" && m.content === "stale answer")).toBe(false);
  });

  it("a fence rejection rolls the host back to file truth instead of wedging later writes", () => {
    const { session, reopen } = fixture();
    const fence = new SessionContextFence(session);
    const staleRevision = fence.getRevision();
    reopen().appendMessage({ role: "user", content: "foreign instruction" });
    expect(() => session.appendMessage({ role: "assistant", content: "stale answer" }, staleRevision))
      .toThrow(SessionHistoryDivergedError);

    // Host rollback contract: replace resident history with the file's truth
    // (the rejected message must not linger) and adopt the current revision.
    const history = fence.reloadHistory();
    expect(history.some(m => m.role === "user" && m.content === "foreign instruction")).toBe(true);
    expect(history.some(m => m.role === "assistant" && m.content === "stale answer")).toBe(false);
    expect(fence.getRevision()).toBe(session.getRevision());

    // The next fenced write succeeds — the stale revision no longer wedges the session.
    expect(() => session.appendMessage({ role: "assistant", content: "recovered" }, fence.getRevision())).not.toThrow();
    fence.dispose();
  });
});

describe("PR76 round-2: manual compaction summarizes only the evicted portion", () => {
  it("excludes kept-verbatim turns from oldMessages, keeps prior summary carriers", () => {
    const { session } = fixture();
    seedLegacySummary(session.getSessionFile(), "prior facts survive");
    for (let turn = 0; turn < 5; turn++) {
      session.appendMessage({ role: "user", content: `task ${turn}` });
      session.appendMessage({ role: "assistant", content: `detail ${turn} `.repeat(40) });
    }
    const plan = session.getCompactionPlan();
    expect(plan).not.toBeNull();
    const texts = plan!.oldMessages.map(m => (typeof m.content === "string" ? m.content : ""));

    // The last two turns survive verbatim; they must not be summarized again.
    expect(texts).not.toContain("task 3");
    expect(texts).not.toContain("task 4");
    // Evicted middle turns feed the summarizer...
    expect(texts).toContain("task 1");
    expect(texts).toContain("task 2");
    // ...along with the prior summary carrier, so its facts roll forward.
    expect(texts.some(text => text.includes("prior facts survive"))).toBe(true);

    // The plan still applies end-to-end.
    expect(session.applyLLMCompaction("new summary").compacted).toBe(true);
    const persisted = session.getMessages();
    expect(persisted.some(m => m.role === "meta" && m.kind === "compaction-summary")).toBe(true);
  });
});

describe("PR76 round-2: compactor input trimming keeps call/result pairs whole", () => {
  it("drops an assistant call and its interleaved result together, never orphaning the result", () => {
    const messages: Message[] = [
      { role: "user", content: "inspect both files" },
      {
        role: "assistant",
        content: "checking the first file",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      },
      { role: "meta", kind: "system-reminder", content: "budget reminder" },
      { role: "tool", toolCallId: "call-1", content: "x".repeat(80_000) },
      {
        role: "assistant",
        content: "checking the second file",
        toolCalls: [{ id: "call-2", name: "read_file", arguments: '{"path":"b.ts"}' }],
      },
      { role: "tool", toolCallId: "call-2", content: "file body b" },
    ];

    // Trimming comes first: the oversized result loses its middle, both pairs survive.
    const trimmed = fitSummaryInput(messages, "summarize", 2_000, "test");
    expect(trimmed).toBeDefined();
    expect(trimmed!.historyText).toContain("checking the first file");
    expect(trimmed!.historyText).toContain('TOOL_CALL[read_file]: {"path":"a.ts"}');
    expect(trimmed!.historyText).toContain("characters omitted");
    expect(trimmed!.historyText).toContain("TOOL_RESULT[read_file]: file body b");
    expect(trimmed!.historyText).toContain("show only their head and tail");
    expect(trimmed!.degradation).toBeUndefined();

    // Dropping is the last resort — and when it happens the pair goes whole:
    // no orphan result, no nameless fallback line. Prose cannot be trimmed, so
    // an oversized assistant message forces its group out.
    const withProse = messages.map((message, index) =>
      index === 1 ? { ...message, content: "checking the first file " + "y".repeat(80_000) } : message);
    const dropped = fitSummaryInput(withProse, "summarize", 2_000, "test");
    expect(dropped).toBeDefined();
    expect(dropped!.historyText).not.toContain("TOOL_RESULT[tool]");
    expect(dropped!.historyText).not.toContain("checking the first file");
    expect(dropped!.historyText).not.toContain("a.ts");
    // Interleaved runtime context and the surviving pair stay present.
    expect(dropped!.historyText).toContain("budget reminder");
    expect(dropped!.historyText).toContain("TOOL_CALL[read_file]");
    expect(dropped!.degradation).toContain("omitted 1 older assistant/tool groups");
  });

  it("keeps a pair whole when a meta reminder sits between the call and its result at full size", () => {
    const messages: Message[] = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      },
      { role: "meta", kind: "system-reminder", content: "reminder" },
      { role: "tool", toolCallId: "call-1", content: "file body a" },
    ];
    const fitted = fitSummaryInput(messages, "summarize", 4_000, "test");
    expect(fitted).toBeDefined();
    expect(fitted!.historyText).toContain("TOOL_CALL[read_file]");
    expect(fitted!.historyText).toContain("TOOL_RESULT[read_file]: file body a");
    expect(fitted!.degradation).toBeUndefined();
  });
});

describe("summary input keeps breadth when tool results are large", () => {
  const reads = (count: number, size: number): Message[] => [
    { role: "user", content: "survey the modules" },
    ...Array.from({ length: count }, (_, i): Message[] => [
      { role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", arguments: `{"path":"src/module-${i}.ts"}` }] },
      { role: "tool", toolCallId: `r${i}`, content: `// module ${i} head\n` + "x".repeat(size) + `\n// module ${i} tail` },
    ]).flat(),
  ];

  it("trims every large result to a common budget-derived cap instead of dropping the older reads", () => {
    const started = Date.now();
    const fitted = fitSummaryInput(reads(30, 12_000), "summarize", 20_000, "test");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fitted).toBeDefined();
    for (let i = 0; i < 30; i++) {
      expect(fitted!.historyText).toContain(`src/module-${i}.ts`);
      expect(fitted!.historyText).toContain(`// module ${i} head`);
      expect(fitted!.historyText).toContain(`// module ${i} tail`);
    }
    expect(fitted!.historyText).toContain("show only their head and tail");
    expect(fitted!.degradation).toBeUndefined();
  });

  it("caps results and arguments together, so large arguments do not erase every result", () => {
    const messages: Message[] = [{ role: "user", content: "rewrite the modules" }];
    for (let i = 0; i < 6; i++) {
      messages.push(
        { role: "assistant", content: "", toolCalls: [{ id: `r${i}`, name: "read_file", arguments: `{"path":"src/in-${i}.ts"}` }] },
        { role: "tool", toolCallId: `r${i}`, content: `READ-HEAD-${i} ` + "r".repeat(12_000) },
        { role: "assistant", content: "", toolCalls: [{ id: `w${i}`, name: "write_file", arguments: `{"path":"src/out-${i}.ts","content":"` + "w".repeat(40_000) + '"}' }] },
        { role: "tool", toolCallId: `w${i}`, content: "ok" },
      );
    }
    const fitted = fitSummaryInput(messages, "summarize", 8_000, "test")!;
    for (let i = 0; i < 6; i++) {
      expect(fitted.historyText).toContain(`READ-HEAD-${i}`);
      expect(fitted.historyText).toContain(`src/in-${i}.ts`);
      expect(fitted.historyText).toContain(`src/out-${i}.ts`);
    }
    expect(fitted.degradation).toBeUndefined();
  });

  it("searches the cap again after dropping a group, so survivors are as complete as the room allows", () => {
    const messages: Message[] = [
      { role: "user", content: "investigate" },
      { role: "assistant", content: "untrimmable prose " + "p".repeat(80_000) },
      ...reads(4, 3_000).slice(1),
    ];
    const fitted = fitSummaryInput(messages, "summarize", 8_000, "test")!;
    expect(fitted.degradation).toContain("omitted 1 older assistant/tool groups");
    expect(fitted.historyText).not.toContain("untrimmable prose");
    // All four reads fit verbatim once the prose is gone: nothing is trimmed.
    expect(fitted.historyText).not.toContain("characters omitted");
    expect(fitted.historyText).toContain("x".repeat(3_000));
  });

  it("never splits a surrogate pair at a trim boundary", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // Both alignments, every cap: head and tail each land inside a pair somewhere.
    for (const text of ["😀".repeat(400), "a" + "😀".repeat(400)]) {
      let trimmed = 0;
      for (let cap = 0; cap <= 120; cap++) {
        const capped = capPayload(text, cap);
        expect(lone.test(capped)).toBe(false);
        if (capped !== text) {
          trimmed++;
          expect(capped).toMatch(/\[\.\.\. \d+ of \d+ characters omitted \.\.\.\]/);
          expect(capped.length).toBeLessThan(text.length);
        }
      }
      expect(trimmed).toBeGreaterThan(100);
    }
    expect(capPayload("short", 3)).toBe("short"); // A marker longer than the saving is pointless.
    expect(capPayload("anything", undefined)).toBe("anything");
  });

  it("leaves small results whole and spends the budget it has", () => {
    const messages = reads(6, 12_000);
    messages.push(
      { role: "assistant", content: "", toolCalls: [{ id: "small", name: "read_file", arguments: '{"path":"src/tiny.ts"}' }] },
      { role: "tool", toolCallId: "small", content: "export const tiny = true;" },
    );
    const tight = fitSummaryInput(messages, "summarize", 6_000, "test")!;
    const roomy = fitSummaryInput(messages, "summarize", 12_000, "test")!;
    expect(tight.historyText).toContain("TOOL_RESULT[read_file]: export const tiny = true;");
    // A larger window keeps more of each result: the cap follows the budget.
    expect(roomy.historyText.length).toBeGreaterThan(tight.historyText.length);
    expect(fitSummaryInput(messages, "summarize", 200_000, "test")!.degradation).toBeUndefined();
  });
});
