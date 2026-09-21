import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { SessionManager } from "../session.js";
import { createContextCheckpoint } from "../context/checkpoint.js";
import { buildCompactionSummaryMessage } from "../context/compact.js";
import { Agent } from "../agent.js";
import type { Message, Provider } from "../types.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-context-checkpoint-")); dirs.push(dir);
  const file = join(dir, "session.jsonl");
  const manager = new SessionManager(file);
  manager.appendMessage({ role: "user", content: "Keep the database unchanged" });
  manager.appendMessage({ role: "assistant", content: "original detailed investigation" });
  return { file, manager };
}
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const projection: Message[] = [
  { role: "user", content: "Keep the database unchanged" },
  buildCompactionSummaryMessage("Decision: token budget. Remaining: test recovery."),
  { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "read", arguments: '{"path":"a.ts"}' }] },
  { role: "tool", toolCallId: "read-1", content: "recent result" },
];

describe("durable context checkpoints", () => {
  it("recovers locks left by a terminated writer but never breaks a live owner", () => {
    const { file, manager } = fixture();
    const child = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.pid + ':crashed'); process.kill(process.pid, 'SIGKILL')", file + ".write-lock"]);
    expect(child.signal).toBe("SIGKILL");
    manager.appendMessage({ role: "user", content: "after restart" });
    writeFileSync(file + ".write-lock", `${process.pid}:live`);
    expect(() => manager.appendMessage({ role: "user", content: "must not commit" })).toThrow();
    expect(new SessionManager(file).getMessages().at(-1)?.content).toBe("after restart");
  });

  it("rejects an old receipt after clear and a projection writer after a foreign append", () => {
    const { file, manager } = fixture();
    const cp = createContextCheckpoint(projection, "auto", "summary", manager.getRevision());
    manager.commitContextCheckpoint(cp);
    manager.appendMarker("conversation_clear", "");
    expect(() => manager.commitContextCheckpoint(cp)).toThrow("Stale");
    const revision = manager.getRevision();
    new SessionManager(file).appendMessage({ role: "user", content: "foreign instruction" });
    expect(() => manager.appendMessage({ role: "assistant", content: "old answer" }, revision)).toThrow("active turn");
  });

  it("rejects a manual summary when its planned snapshot changed", () => {
    const { manager } = fixture();
    for (let i = 0; i < 4; i++) {
      manager.appendMessage({ role: "user", content: `task ${i}` });
      manager.appendMessage({ role: "assistant", content: "detail".repeat(100) });
    }
    expect(manager.getCompactionPlan()).not.toBeNull();
    manager.appendMessage({ role: "user", content: "new constraint" });
    expect(() => manager.applyLLMCompaction("stale summary")).toThrow("Stale compaction plan");
  });

  it("keeps originals and restores the exact single-turn projection including complete tool groups", () => {
    const { file, manager } = fixture();
    const original = readFileSync(file, "utf8");
    const cp = createContextCheckpoint([{ role: "system", content: "host-only secret prompt" }, ...projection], "auto", "summary", manager.getRevision());
    manager.commitContextCheckpoint(cp);
    expect(readFileSync(file, "utf8").startsWith(original)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("host-only secret prompt");
    expect(manager.getMessages()).toEqual(projection);
    expect(new SessionManager(file).getMessages()).toEqual(projection);
    manager.appendMessage({ role: "user", content: "continue" });
    expect(new SessionManager(file).getMessages()).toEqual([...projection, { role: "user", content: "continue" }]);
  });

  it("is idempotent, rejects conflicting ids and stale revisions", () => {
    const { file, manager } = fixture();
    const cp = createContextCheckpoint(projection, "auto", "summary", manager.getRevision());
    manager.commitContextCheckpoint(cp);
    const stored = readFileSync(file, "utf8");
    manager.commitContextCheckpoint(cp);
    expect(readFileSync(file, "utf8")).toBe(stored);
    expect(() => manager.commitContextCheckpoint({ ...cp, summary: "changed" })).toThrow("Conflicting");
    const stale = createContextCheckpoint(projection, "auto", "summary", manager.getRevision());
    manager.appendMessage({ role: "user", content: "new requirement" });
    expect(() => manager.commitContextCheckpoint(stale)).toThrow("Stale");
  });

  it("does not publish candidate on disk failure or a competing writer", () => {
    const { file, manager } = fixture();
    const before = manager.getMessages();
    const cp = createContextCheckpoint(projection, "auto", "summary", manager.getRevision());
    writeFileSync(file + ".write-lock", "test lock");
    expect(() => manager.commitContextCheckpoint(cp)).toThrow();
    expect(manager.getMessages()).toEqual(before);
    unlinkSync(file + ".write-lock");
    const other = new SessionManager(file);
    other.appendMessage({ role: "user", content: "external change" });
    expect(() => manager.commitContextCheckpoint(cp)).toThrow("Session changed");
    expect(new SessionManager(file).getMessages().at(-1)?.content).toBe("external change");
  });

  it("clear and rewind never bring back a future checkpoint", () => {
    const { file, manager } = fixture();
    manager.appendMessage({ role: "user", content: "second turn" });
    const anchor = manager.lastUserEntryId();
    manager.commitContextCheckpoint(createContextCheckpoint(projection, "auto", "future summary", manager.getRevision()));
    manager.rewindToEntry(anchor);
    expect(new SessionManager(file).getMessages().map(m => m.content)).toEqual(["Keep the database unchanged", "original detailed investigation"]);
    manager.commitContextCheckpoint(createContextCheckpoint(projection, "auto", "summary", manager.getRevision()));
    manager.appendMarker("conversation_clear", "");
    manager.appendMessage({ role: "user", content: "new conversation" });
    expect(new SessionManager(file).getMessages()).toEqual([{ role: "user", content: "new conversation" }]);
  });

  it("keeps all originals across three checkpoints and reads legacy summaries", () => {
    const { file, manager } = fixture();
    manager.appendCompaction("legacy incomplete history");
    expect(manager.getMessages()[0].content).toContain("legacy incomplete history");
    for (let i = 0; i < 3; i++) {
      manager.appendMessage({ role: "user", content: `turn ${i}` });
      manager.commitContextCheckpoint(createContextCheckpoint([...projection, { role: "user", content: `turn ${i}` }], "auto", "summary", manager.getRevision()));
    }
    const entries = new SessionManager(file).getEntries();
    expect(entries.filter(e => e.type === "context_checkpoint")).toHaveLength(3);
    expect(entries.filter(e => e.type === "user_message")).toHaveLength(4);
    expect(new SessionManager(file).getMessages().at(-1)?.content).toBe("turn 2");
  });

  it("isolates corrupted crash tails on the next append", () => {
    const { file } = fixture();
    appendFileSync(file, '{"type":"context_checkpoint","checkpoint":');
    const manager = new SessionManager(file);
    manager.appendMessage({ role: "user", content: "safe continuation" });
    expect(new SessionManager(file).getMessages().at(-1)?.content).toBe("safe continuation");
  });

  it("commits before changing Agent memory and fails closed on cancellation or persistence failure", () => {
    const { file, manager } = fixture();
    const agent = new Agent({ provider: {} as Provider, model: "test", tools: [], onContextCheckpoint: cp => manager.commitContextCheckpoint(cp) });
    const before: Message[] = [{ role: "system", content: "system" }, ...manager.getMessages()];
    agent.messages = before;
    const apply = (messages: Message[], signal?: AbortSignal) => (agent as any).applyContextCheckpoint(messages, "auto", "summary", manager.getRevision(), signal);
    const controller = new AbortController(); controller.abort();
    expect(() => apply(projection, controller.signal)).toThrow();
    expect(agent.messages).toBe(before);
    writeFileSync(file + ".write-lock", "test lock");
    expect(() => apply(projection)).toThrow();
    expect(agent.messages).toBe(before);
    unlinkSync(file + ".write-lock");
    apply([{ role: "system", content: "system" }, ...projection]);
    expect(agent.messages.slice(1)).toEqual(new SessionManager(file).getMessages());
  });
});
