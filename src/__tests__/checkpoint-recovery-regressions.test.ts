import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session.js";
import { Agent } from "../agent.js";
import { createContextCheckpoint } from "../context/checkpoint.js";
import { buildCompactionSummaryMessage } from "../context/compact.js";
import type { Message, Provider } from "../types.js";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-checkpoint-regression-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  const manager = new SessionManager(file);
  manager.appendMessage({ role: "user", content: "Keep my constraints" });
  manager.appendMessage({ role: "assistant", content: "Acknowledged" });
  return { manager, file };
}
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const prefix: Message[] = [
  { role: "user", content: "Keep my constraints" },
  buildCompactionSummaryMessage("Previous decisions"),
];
const group: Message[] = [
  { role: "assistant", content: "", toolCalls: [
    { id: "a", name: "read", arguments: "{}" },
    { id: "b", name: "read", arguments: "{}" },
  ] },
  { role: "tool", toolCallId: "a", content: "first result" },
  { role: "tool", toolCallId: "b", content: "second result" },
];

describe("checkpoint review regressions", () => {
  it.each(["auto", "overflow", "resident"] as const)("keeps live reminders outside the %s durable projection", reason => {
    const { manager, file } = fixture();
    const agent = new Agent({ provider: {} as Provider, model: "test", tools: [], onContextCheckpoint: cp => manager.commitContextCheckpoint(cp) });
    const startup: Message = { role: "meta", kind: "runtime-context", content: "startup" };
    const active: Message = { role: "meta", kind: "system-reminder", content: "Current hook restriction" };
    const expired: Message = { role: "meta", kind: "runtime-context", content: "Old plan mode", includeInLlm: false };
    agent.messages = [startup, ...manager.getMessages(), expired, active];
    // A compactor is allowed to omit reminders from the conversational candidate.
    (agent as any).applyContextCheckpoint([startup, ...prefix], reason, "Previous decisions", manager.getRevision());
    expect(agent.messages).toEqual([startup, ...prefix, active]);
    expect(agent.messages.at(-1)).toBe(active); // mode invalidation still owns this object
    expect(new SessionManager(file).getMessages()).toEqual(prefix);
    (agent as any).applyContextCheckpoint(agent.messages, reason, "Previous decisions", manager.getRevision());
    expect(agent.messages.filter(m => m.content === active.content)).toHaveLength(1);
  });

  it.each([0, 1, 2])("discards a same-turn incomplete tool group after %i suffix records", count => {
    const { manager, file } = fixture();
    manager.commitContextCheckpoint(createContextCheckpoint(prefix, "auto", "summary", manager.getRevision()));
    for (const message of group.slice(0, count)) manager.appendMessage(message);
    expect(new SessionManager(file).getMessages()).toEqual(prefix);
  });

  it("keeps completed same-turn groups and prunes only the broken continuation", () => {
    const { manager, file } = fixture();
    manager.commitContextCheckpoint(createContextCheckpoint(prefix, "auto", "summary", manager.getRevision()));
    for (const message of group) manager.appendMessage(message);
    expect(new SessionManager(file).getMessages()).toEqual([...prefix, ...group]);
    manager.appendMessage({ role: "assistant", content: "", toolCalls: [{ id: "c", name: "read", arguments: "{}" }] });
    expect(new SessionManager(file).getMessages()).toEqual([...prefix, ...group]);
    manager.appendMessage({ role: "user", content: "Continue safely" });
    expect(new SessionManager(file).getMessages()).toEqual([...prefix, ...group, { role: "user", content: "Continue safely" }]);
  });

  it.each(["append", "clear"])("rejects a stale caller when a foreign %s races with refresh", operation => {
    const { manager, file } = fixture();
    const revision = manager.getRevision();
    const refresh = (manager as any).refresh.bind(manager);
    vi.spyOn(manager as any, "refresh").mockImplementationOnce(() => {
      const other = new SessionManager(file);
      if (operation === "clear") other.appendMarker("conversation_clear", "");
      else other.appendMessage({ role: "user", content: "Foreign instruction" });
      refresh();
    });
    expect(() => manager.appendMessage({ role: "assistant", content: "Stale answer" }, revision)).toThrow("active turn");
    expect(new SessionManager(file).getEntries().some(e => e.type === "assistant_message" && e.message.content === "Stale answer")).toBe(false);
  });

  it("checks the caller revision while holding the actual session lock", () => {
    const { manager, file } = fixture();
    const revision = manager.getRevision();
    const getRevision = manager.getRevision.bind(manager);
    let checkedUnderLock = false;
    vi.spyOn(manager, "getRevision").mockImplementation(() => {
      checkedUnderLock ||= existsSync(file + ".write-lock");
      return getRevision();
    });
    manager.appendMessage({ role: "assistant", content: "Fresh answer" }, revision);
    expect(checkedUnderLock).toBe(true);
  });

  it("does not invalidate active replies or checkpoints for local/foreign title updates", () => {
    const { manager, file } = fixture();
    const revision = manager.getRevision();
    manager.updateMetadata({ title: "Local title" });
    expect(manager.getRevision()).toBe(revision);
    new SessionManager(file).updateMetadata({ title: "Foreign title" });
    manager.appendMessage({ role: "assistant", content: "Fresh answer" }, revision);
    expect(manager.getMetadata().title).toBe("Foreign title");
    expect(manager.getRevision()).not.toBe(revision);
    const cp = createContextCheckpoint(prefix, "auto", "summary", manager.getRevision());
    new SessionManager(file).updateMetadata({ title: "While summarizing" });
    manager.commitContextCheckpoint(cp);
    new SessionManager(file).updateMetadata({ title: "After checkpoint" });
    manager.commitContextCheckpoint(cp); // metadata does not supersede its receipt
    expect(new SessionManager(file).getMessages()).toEqual(prefix);
    expect(manager.getMetadata().title).toBe("After checkpoint");
  });

  it("keeps a manual compaction plan valid across metadata-only writes", () => {
    const { manager, file } = fixture();
    for (let i = 0; i < 5; i++) {
      manager.appendMessage({ role: "user", content: `task ${i}` });
      manager.appendMessage({ role: "assistant", content: "detail ".repeat(100) });
    }
    expect(manager.getCompactionPlan()).not.toBeNull();
    new SessionManager(file).updateMetadata({ title: "Async title" });
    expect(manager.applyLLMCompaction("Still valid summary").compacted).toBe(true);
    expect(manager.getMetadata().title).toBe("Async title");
  });
});
