import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointStore } from "../checkpoints.js";
import { SessionManager } from "../session.js";
import { builtinSlashCommands } from "../slash-commands/commands.js";
import type { SlashCommandContext } from "../slash-commands/types.js";

let counter = 0;
function freshDir(): string {
  const dir = join(tmpdir(), `bubble-test-rewind-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("SessionManager rewind", () => {
  it("lists user turns in order", () => {
    const dir = freshDir();
    const sm = new SessionManager(join(dir, "s.jsonl"));
    sm.appendMessage({ role: "user", content: "first question" });
    sm.appendMessage({ role: "assistant", content: "answer one" });
    sm.appendMessage({ role: "user", content: "second question" });

    const turns = sm.listUserTurns();
    expect(turns).toHaveLength(2);
    expect(turns[0].preview).toBe("first question");
    expect(turns[1].preview).toBe("second question");
  });

  it("excludes turns before the latest conversation_clear", () => {
    const dir = freshDir();
    const sm = new SessionManager(join(dir, "s.jsonl"));
    sm.appendMessage({ role: "user", content: "before clear" });
    sm.appendMarker("conversation_clear", "");
    sm.appendMessage({ role: "user", content: "after clear" });

    const turns = sm.listUserTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0].preview).toBe("after clear");
  });

  it("truncates the session to just before the target user message", () => {
    const dir = freshDir();
    const file = join(dir, "s.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "keep me" });
    sm.appendMessage({ role: "assistant", content: "kept answer" });
    sm.appendMessage({ role: "user", content: "drop me" });
    sm.appendMessage({ role: "assistant", content: "dropped answer" });

    const target = sm.listUserTurns()[1];
    const result = sm.rewindToEntry(target.id);
    expect(result?.removedEntries).toBe(2);
    expect(result?.targetText).toBe("drop me");

    const messages = sm.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "kept answer" });

    // Persisted truncation survives a reload.
    const reloaded = new SessionManager(file);
    expect(reloaded.getMessages()).toHaveLength(2);
  });

  it("returns undefined for an unknown entry id", () => {
    const dir = freshDir();
    const sm = new SessionManager(join(dir, "s.jsonl"));
    sm.appendMessage({ role: "user", content: "hello" });
    expect(sm.rewindToEntry("999")).toBeUndefined();
  });

  it("tracks the last user entry id as turns advance", () => {
    const dir = freshDir();
    const sm = new SessionManager(join(dir, "s.jsonl"));
    expect(sm.lastUserEntryId()).toBe("0");
    sm.appendMessage({ role: "user", content: "one" });
    const first = sm.lastUserEntryId();
    sm.appendMessage({ role: "assistant", content: "ack" });
    expect(sm.lastUserEntryId()).toBe(first);
    sm.appendMessage({ role: "user", content: "two" });
    expect(Number(sm.lastUserEntryId())).toBeGreaterThan(Number(first));
  });
});

describe("CheckpointStore", () => {
  it("restores pre-edit content for files changed at or after the cutoff turn", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "original");

    let turn = "1";
    const store = new CheckpointStore(join(dir, "cp"), () => turn);

    await store.captureBefore(target, "original");
    writeFileSync(target, "after turn 1");

    turn = "2";
    await store.captureBefore(target, "after turn 1");
    writeFileSync(target, "after turn 2");

    // Rewinding to before turn 2 keeps turn 1's result.
    const result = await store.restoreTo("2");
    expect(result.restored).toEqual([target]);
    expect(readFileSync(target, "utf-8")).toBe("after turn 1");
  });

  it("uses the earliest capture when a file changes across several turns", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "v0");

    let turn = "1";
    const store = new CheckpointStore(join(dir, "cp"), () => turn);
    await store.captureBefore(target, "v0");
    writeFileSync(target, "v1");
    turn = "2";
    await store.captureBefore(target, "v1");
    writeFileSync(target, "v2");

    await store.restoreTo("1");
    expect(readFileSync(target, "utf-8")).toBe("v0");
  });

  it("deletes files that were created during rewound turns", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "new.txt");

    const store = new CheckpointStore(join(dir, "cp"), () => "3");
    await store.captureBefore(target, null);
    writeFileSync(target, "created in turn 3");

    const result = await store.restoreTo("3");
    expect(result.deleted).toEqual([target]);
    expect(existsSync(target)).toBe(false);
  });

  it("only records the first capture of a file within a turn", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "v0");

    const store = new CheckpointStore(join(dir, "cp"), () => "1");
    await store.captureBefore(target, "v0");
    await store.captureBefore(target, "v0 modified mid-turn");

    expect(store.listEntries()).toHaveLength(1);
    await store.restoreTo("1");
    expect(readFileSync(target, "utf-8")).toBe("v0");
  });

  it("prunes consumed manifest entries so reused turn ids cannot resurrect stale state", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "v0");

    const store = new CheckpointStore(join(dir, "cp"), () => "2");
    await store.captureBefore(target, "v0");
    writeFileSync(target, "v1");

    await store.restoreTo("2");
    expect(store.filesTouchedSince("0")).toEqual([]);
    // A later rewind over the same turn id finds nothing to restore.
    writeFileSync(target, "new work after rewind");
    const second = await store.restoreTo("2");
    expect(second.restored).toEqual([]);
    expect(readFileSync(target, "utf-8")).toBe("new work after rewind");
  });

  it("command rewinds conversation and files together", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "original");

    const sm = new SessionManager(join(dir, "s.jsonl"));
    sm.appendMessage({ role: "user", content: "turn one" });
    sm.appendMessage({ role: "assistant", content: "done one" });
    sm.appendMessage({ role: "user", content: "turn two" });
    // Simulate an edit-tool mutation during turn two.
    await sm.getCheckpoints().captureBefore(target, "original");
    writeFileSync(target, "changed in turn two");
    sm.appendMessage({ role: "assistant", content: "done two" });

    const fakeAgent = {
      messages: [{ role: "system", content: "sys" }] as any[],
      resetContextUsageAnchor: () => {},
    };
    let composer = "";
    let pickerOpened = false;
    const ctx = {
      agent: fakeAgent,
      sessionManager: sm,
      addMessage: () => {},
      clearMessages: () => {},
      openRewindPicker: () => { pickerOpened = true; },
      fillComposer: (text: string) => { composer = text; },
    } as unknown as SlashCommandContext;

    const rewind = builtinSlashCommands.find((cmd) => cmd.name === "rewind")!;

    // With a picker available, bare /rewind opens it instead of printing text.
    const listing = await rewind.handler("", ctx);
    expect(listing).toBeUndefined();
    expect(pickerOpened).toBe(true);

    const output = await rewind.handler("2", ctx);
    expect(output).toMatch(/^⏪ Rewound to before: turn two/);
    expect(output).toContain(`Restored ${target}`);
    expect(readFileSync(target, "utf-8")).toBe("original");
    expect(sm.getMessages()).toHaveLength(2);
    expect(fakeAgent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(composer).toBe("turn two");
  });

  it("command without picker support falls back to a text listing", async () => {
    const dir = freshDir();
    const sm = new SessionManager(join(dir, "s.jsonl"));
    sm.appendMessage({ role: "user", content: "hello there" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const ctx = {
      agent: { messages: [], resetContextUsageAnchor: () => {} },
      sessionManager: sm,
      addMessage: () => {},
      clearMessages: () => {},
    } as unknown as SlashCommandContext;

    const rewind = builtinSlashCommands.find((cmd) => cmd.name === "rewind")!;
    const listing = await rewind.handler("", ctx);
    expect(listing).toContain("hello there");
    expect(listing).toContain("/rewind <n>");
  });

  it("reports files touched per turn", async () => {
    const dir = freshDir();
    const workspace = freshDir();
    const a = join(workspace, "a.txt");
    const b = join(workspace, "b.txt");
    writeFileSync(a, "a");
    writeFileSync(b, "b");

    let turn = "1";
    const store = new CheckpointStore(join(dir, "cp"), () => turn);
    await store.captureBefore(a, "a");
    turn = "2";
    await store.captureBefore(b, "b");

    expect(store.filesTouchedAt("1")).toEqual([a]);
    expect(store.filesTouchedAt("2")).toEqual([b]);
    expect(store.filesTouchedSince("1").sort()).toEqual([a, b].sort());
  });
});
