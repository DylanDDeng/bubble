import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session.js";
import { SessionContextFence } from "../session-context-fence.js";
import { createContextCheckpoint } from "../context/checkpoint.js";
import { createSanitizedProviderError } from "../provider-error-record.js";
import { Agent } from "../agent.js";
import type { Provider } from "../types.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-pr76-fence-"));
  dirs.push(dir);
  const session = new SessionManager(join(dir, "session.jsonl"));
  session.appendMessage({ role: "user", content: "original" });
  session.appendMessage({ role: "assistant", content: "ack" });
  return { session, reopen: () => new SessionManager(session.getSessionFile()) };
}
const diagnostic = createSanitizedProviderError(new Error("failed"), {
  providerId: "test", modelId: "test", thinkingLevel: "off", messageCount: 1, toolCount: 0,
});
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("PR76 history fences and semantic revisions", () => {
  it.each(["append", "clear"])("rejects a deferred provider output after foreign %s plus refresh", async mutation => {
    const { session, reopen } = fixture();
    const fence = new SessionContextFence(session);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider: Provider = {
      async complete() { return "summary"; },
      async *streamChat() { entered(); await pending; yield { type: "text", content: "stale answer" }; yield { type: "done" }; },
    };
    const agent = new Agent({ provider, model: "test", tools: [],
      onMessageAppend: message => {
        if (message.role !== "system" && message.role !== "meta") session.appendMessage(message, fence.getRevision());
      },
      getContextRevision: () => fence.getRevision(),
    });
    agent.messages = fence.reloadHistory();
    const turn = (async () => { for await (const _event of agent.run("next", process.cwd())) { /* drain */ } })();
    const rejected = expect(turn).rejects.toThrow("active turn");
    await started;
    if (mutation === "clear") reopen().appendMarker("conversation_clear", "");
    else reopen().appendMessage({ role: "user", content: "foreign instruction" });
    session.updateMetadata({ title: "refresh without history replacement" });
    release();
    await rejected;
    expect(reopen().getEntries().some(e => e.type === "assistant_message" && e.message.content === "stale answer")).toBe(false);
  });

  it.each(["auto", "overflow", "manual"] as const)("keeps %s candidates and receipts valid across audit writes", reason => {
    const { session, reopen } = fixture();
    const revision = session.getRevision();
    const checkpoint = createContextCheckpoint(session.getMessages(), reason, "summary", revision);
    for (const kind of ["task_started", "task_finished", "task_killed"] as const) reopen().appendMarker(kind, "{}");
    reopen().appendProviderError(diagnostic);
    reopen().updateMetadata({ title: "async title" });
    session.commitContextCheckpoint(checkpoint);
    reopen().appendMarker("task_finished", "{}");
    session.commitContextCheckpoint(checkpoint);
    expect(reopen().getEntries().filter(e => e.type === "context_checkpoint")).toHaveLength(1);
    reopen().appendMarker("conversation_clear", "");
    expect(() => session.commitContextCheckpoint(checkpoint)).toThrow();
  });

  it("preserves a manual plan through task completion, but not contextual markers", () => {
    const { session, reopen } = fixture();
    for (let i = 0; i < 6; i++) {
      session.appendMessage({ role: "user", content: `task ${i}` });
      session.appendMessage({ role: "assistant", content: "detail ".repeat(100) });
    }
    expect(session.getCompactionPlan()).not.toBeNull();
    reopen().appendMarker("task_finished", "{}");
    expect(session.applyLLMCompaction("valid summary").compacted).toBe(true);
    const revision = session.getRevision();
    reopen().appendMarker("mode_switch", "plan");
    expect(() => session.appendMessage({ role: "assistant", content: "stale" }, revision)).toThrow();
  });

  it("advances only local commits or explicit reloads, including clear, rewind and compact", () => {
    const { session, reopen } = fixture();
    const fence = new SessionContextFence(session);
    for (let i = 0; i < 6; i++) {
      session.appendMessage({ role: "user", content: `task ${i}` }, fence.getRevision());
      session.appendMessage({ role: "assistant", content: "detail ".repeat(100) }, fence.getRevision());
    }
    session.compact();
    expect(fence.getRevision()).toBe(session.getRevision());
    session.rewindToEntry(session.listUserTurns().at(-1)!.id);
    expect(fence.getRevision()).toBe(session.getRevision());
    session.appendMarker("conversation_clear", "");
    expect(fence.getRevision()).toBe(session.getRevision());
    const revision = fence.getRevision();
    reopen().appendMessage({ role: "user", content: "foreign" });
    session.appendMarker("task_finished", "{}");
    expect(fence.getRevision()).toBe(revision);
    fence.reloadHistory();
    expect(fence.getRevision()).toBe(session.getRevision());
    fence.dispose();
  });
});

describe("PR76 atomic rewind metadata", () => {
  it.each(["retained", "removed", "cleared"])("cold reopens latest full metadata with %s title anchor", titleCase => {
    const { session, reopen } = fixture();
    const retained = session.listUserTurns()[0].id;
    session.updateMetadata({ title: "old title", titleUserMessageId: retained, model: "old", externalRuntime: { id: "grok", sessionId: "old" } });
    session.appendMessage({ role: "user", content: "rewind here" });
    const removed = session.listUserTurns().at(-1)!.id;
    session.updateMetadata({ model: "new", thinkingLevel: "high", goal: { objective: "latest goal" } as any,
      title: "latest title", titleSource: "llm", titleUpdatedAt: 7,
      titleUserMessageId: titleCase === "retained" ? retained : removed });
    session.clearExternalRuntimeMetadata();
    if (titleCase === "cleared") session.clearTitleMetadata();
    const latest = session.getMetadata();
    session.rewindToEntry(removed);
    const expected = { ...latest };
    if (titleCase !== "retained") {
      delete expected.title; delete expected.titleSource; delete expected.titleUpdatedAt; delete expected.titleUserMessageId;
    }
    expect(reopen().getMetadata()).toEqual(expected);
    expect(reopen().getMetadata().externalRuntime).toBeUndefined();
    expect(reopen().listUserTurns().map(t => t.id)).toEqual([retained]);
  });
});
