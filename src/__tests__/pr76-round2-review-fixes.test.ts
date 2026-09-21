import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHistoryDivergedError, SessionManager } from "../session.js";
import { SessionContextFence } from "../session-context-fence.js";
import { fitSummaryInput } from "../context/llm-compactor.js";
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
    session.appendCompaction("prior facts survive");
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

    const fitted = fitSummaryInput(messages, "summarize", 2_000, "test");
    expect(fitted).toBeDefined();
    // The oversized pair is dropped whole: no orphan result, no nameless fallback line.
    expect(fitted!.historyText).not.toContain("TOOL_RESULT[tool]");
    expect(fitted!.historyText).not.toContain("checking the first file");
    // Interleaved runtime context and the surviving pair stay intact.
    expect(fitted!.historyText).toContain("budget reminder");
    expect(fitted!.historyText).toContain("TOOL_RESULT[read_file]: file body b");
    expect(fitted!.degradation).toContain("omitted 1");
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
