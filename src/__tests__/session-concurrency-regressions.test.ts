import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session.js";
import { SessionWriteLockBusyError, withSessionWriteLock } from "../context/session-write-lock.js";
import { buildCompactionSummaryMessage, compactCurrentTurnToolGroups, isCompactionSummaryMessage } from "../context/compact.js";
import { createContextCheckpoint } from "../context/checkpoint.js";
import type { Message } from "../types.js";

const dirs: string[] = [];
function sessionFile() {
  const dir = mkdtempSync(join(tmpdir(), "bubble-session-concurrency-"));
  dirs.push(dir);
  return join(dir, "session.jsonl");
}
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe("session concurrency review regressions", () => {
  it("derives metadata updates from the refreshed snapshot while holding the write lock", () => {
    const file = sessionFile();
    const a = new SessionManager(file);
    a.appendMessage({ role: "user", content: "hello" });
    const b = new SessionManager(file);
    a.updateMetadata({ model: "model-a" });

    // b's resident snapshot predates a's write; the merge must still see it,
    // and must run inside the lock so no writer can land between read and append.
    let lockedDuringMerge = false;
    const original = b.mutateMetadata.bind(b);
    const mutate = vi.spyOn(b, "mutateMetadata");
    mutate.mockImplementation(build => original(current => {
      lockedDuringMerge = existsSync(file + ".write-lock");
      expect(current.model).toBe("model-a");
      return build(current);
    }));
    b.updateMetadata({ thinkingLevel: "high" });
    b.clearTitleMetadata();

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(lockedDuringMerge).toBe(true);
    const reopened = new SessionManager(file).getMetadata();
    expect(reopened.model).toBe("model-a");
    expect(reopened.thinkingLevel).toBe("high");
  });

  it("waits for a live lock owner to release instead of failing immediately", async () => {
    const file = sessionFile();
    const manager = new SessionManager(file);
    manager.appendMessage({ role: "user", content: "first" });
    const lock = file + ".write-lock";
    // A separate live process owns the lock briefly, then releases it.
    const holder = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      fs.writeFileSync(process.argv[1], process.pid + ":holder", { flag: "wx" });
      console.log("held");
      setTimeout(() => fs.unlinkSync(process.argv[1]), 300);
    `, lock], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>(resolve => holder.stdout.once("data", () => resolve()));

    manager.appendMessage({ role: "assistant", content: "second" });
    expect(new SessionManager(file).getMessages().at(-1)?.content).toBe("second");
    await new Promise(resolve => holder.once("exit", resolve));
  });

  it("surfaces a typed busy error when a live owner outlasts the bounded wait", () => {
    const lock = sessionFile() + ".write-lock";
    writeFileSync(lock, `${process.pid}:live`);
    expect(() => withSessionWriteLock(lock, () => undefined, 50)).toThrow(SessionWriteLockBusyError);
  });

  it("keeps an earlier multi-turn summary when LLM compaction replaces a sub-turn summary", () => {
    const file = sessionFile();
    const manager = new SessionManager(file);
    const history: Message[] = [
      buildCompactionSummaryMessage("EARLIER-ONLY-FACT"),
      { role: "user", content: "do the work" },
    ];
    for (let i = 0; i < 5; i++) {
      history.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read", arguments: "{}" }] });
      history.push({ role: "tool", toolCallId: `c${i}`, content: `result ${i}` });
    }
    manager.appendMessage({ role: "user", content: "seed" });
    manager.commitContextCheckpoint(createContextCheckpoint(history, "manual", "EARLIER-ONLY-FACT", manager.getRevision()));
    expect(compactCurrentTurnToolGroups(manager.getMessages()).compacted).toBe(true);

    const plan = manager.getCompactionPlan({ keepRecentTurns: 50 });
    expect(plan).not.toBeNull();
    expect(plan!.oldMessages.some(isCompactionSummaryMessage)).toBe(false);
    const result = manager.applyLLMCompaction("NEW-SUBTURN-SUMMARY");

    expect(result.compacted).toBe(true);
    const summaries = new SessionManager(file).getMessages().filter(isCompactionSummaryMessage)
      .map(message => typeof message.content === "string" ? message.content : "");
    expect(summaries.some(text => text.includes("EARLIER-ONLY-FACT"))).toBe(true);
    expect(summaries.some(text => text.includes("NEW-SUBTURN-SUMMARY"))).toBe(true);
  });

  it("rewinds against the refreshed log after a foreign append", () => {
    const file = sessionFile();
    const stale = new SessionManager(file);
    stale.appendMessage({ role: "user", content: "turn one" });
    stale.appendMessage({ role: "assistant", content: "reply one" });
    stale.appendMessage({ role: "user", content: "turn two" });
    const target = stale.listUserTurns().at(-1)!;

    const foreign = new SessionManager(file);
    foreign.appendMessage({ role: "assistant", content: "foreign reply" });
    foreign.updateMetadata({ model: "foreign-model" });

    const rewound = stale.rewindToEntry(target.id);
    expect(rewound?.removedEntries).toBe(3); // turn two + foreign reply + foreign metadata

    const reopened = new SessionManager(file);
    expect(reopened.getMessages().map(message => message.content)).toEqual(["turn one", "reply one"]);
    expect(reopened.getMetadata().model).toBe("foreign-model");
  });
});
