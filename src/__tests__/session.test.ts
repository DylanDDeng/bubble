import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../session.js";

describe("SessionManager", () => {
  const tmpDir = join(tmpdir(), "bubble-test-session-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  process.env.BUBBLE_HOME = tmpDir;

  afterEach(() => {
    process.env.BUBBLE_HOME = tmpDir;
  });

  it("creates a new session and persists messages", () => {
    const file = join(tmpDir, "test.jsonl");
    const sm = new SessionManager(file);

    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).type).toBe("user_message");
    expect(JSON.parse(lines[1]).type).toBe("assistant_message");
  });

  it("restores messages from disk", () => {
    const file = join(tmpDir, "restore.jsonl");
    const sm1 = new SessionManager(file);
    sm1.appendMessage({ role: "user", content: "a" });
    sm1.appendMessage({ role: "assistant", content: "b" });

    const sm2 = new SessionManager(file);
    const messages = sm2.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("persists todos snapshots and returns the latest on reload", () => {
    const file = join(tmpDir, "todos.jsonl");
    const sm1 = new SessionManager(file);
    sm1.appendTodosSnapshot([
      { content: "a", activeForm: "doing a", status: "pending" },
    ]);
    sm1.appendTodosSnapshot([
      { content: "a", activeForm: "doing a", status: "completed" },
      { content: "b", activeForm: "doing b", status: "in_progress" },
    ]);

    const sm2 = new SessionManager(file);
    expect(sm2.getTodos()).toEqual([
      { content: "a", activeForm: "doing a", status: "completed" },
      { content: "b", activeForm: "doing b", status: "in_progress" },
    ]);
  });

  it("returns an empty todos list when no snapshot has been written", () => {
    const file = join(tmpDir, "no-todos.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "hi" });
    expect(sm.getTodos()).toEqual([]);
  });

  it("handles compaction by injecting a summary", () => {
    const file = join(tmpDir, "compact.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "old" });
    sm.appendMessage({ role: "assistant", content: "reply" });
    sm.appendCompaction("Summary of old chat");
    sm.appendMessage({ role: "user", content: "new" });

    const messages = sm.getMessages();
    expect(messages[0].role).toBe("system");
    expect((messages[0] as any).content).toContain("Summary of old chat");
    expect(messages[1].role).toBe("user");
    expect((messages[1] as any).content).toBe("new");
  });

  it("drops incomplete trailing tool turns when restoring messages", () => {
    const file = join(tmpDir, "incomplete-tool-turn.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    sm.appendMessage({ role: "user", content: "list files" });
    sm.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    });
    sm.appendMessage({ role: "tool", toolCallId: "call_1", content: "package.json" });

    const restored = sm.getMessages();
    expect(restored).toHaveLength(2);
    expect(restored[0].role).toBe("user");
    expect(restored[1].role).toBe("assistant");
    expect((restored[1] as any).content).toBe("hi");
  });

  it("ignores corrupted jsonl lines gracefully", () => {
    const file = join(tmpDir, "corrupt.jsonl");
    writeFileSync(file, '{"type":"message","data":{"role":"user"}}\nthis is not json\n', "utf-8");

    const sm = new SessionManager(file);
    const messages = sm.getMessages();
    expect(messages).toHaveLength(1);
  });

  it("maps legacy reasoningEffort metadata to thinkingLevel", () => {
    const file = join(tmpDir, "legacy-metadata.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        id: "metadata",
        type: "metadata",
        metadata: { model: "openai:gpt-5.4", reasoningEffort: "high" },
        timestamp: Date.now(),
      })}\n`,
      "utf-8",
    );

    const sm = new SessionManager(file);
    expect(sm.getMetadata().thinkingLevel).toBe("high");
  });

  it("persists structured markers", () => {
    const file = join(tmpDir, "marker.jsonl");
    const sm = new SessionManager(file);
    sm.appendMarker("thinking_level_switch", "high");

    const line = readFileSync(file, "utf-8").trim();
    expect(JSON.parse(line).type).toBe("marker");
    expect(JSON.parse(line).kind).toBe("thinking_level_switch");
  });

  it("can resume the latest prior session explicitly", () => {
    const first = SessionManager.create(tmpDir, "resume-a.jsonl");
    first.appendMessage({ role: "user", content: "older" });

    const second = SessionManager.create(tmpDir, "resume-b.jsonl");
    second.appendMessage({ role: "user", content: "newer" });

    const resumed = SessionManager.resume(tmpDir);
    expect(resumed).toBeDefined();
    expect(resumed!.getSessionFile()).toContain("resume-b.jsonl");
  });

  it("creates a fresh session file by default", () => {
    const fresh = SessionManager.createFresh(tmpDir);
    expect(fresh.getMessages()).toHaveLength(0);
    expect(fresh.getSessionFile()).toContain(".jsonl");
  });

  it("compacts older turns into a summary entry", () => {
    const file = join(tmpDir, "compact-structured.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "task one" });
    sm.appendMessage({ role: "assistant", content: "reply one" });
    sm.appendMessage({ role: "user", content: "task two" });
    sm.appendMessage({ role: "assistant", content: "reply two" });
    sm.appendMessage({ role: "user", content: "task three" });
    sm.appendMessage({ role: "assistant", content: "reply three" });

    const result = sm.compact({ keepRecentTurns: 2 });
    expect(result.compacted).toBe(true);

    const lines = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.some((line) => line.type === "summary")).toBe(true);

    const restored = sm.getMessages();
    expect(restored[0].role).toBe("system");
    expect((restored[0] as any).content).toContain("Previous conversation summary:");
  });
});
