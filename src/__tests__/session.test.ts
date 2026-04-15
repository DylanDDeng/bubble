import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../session.js";

describe("SessionManager", () => {
  const tmpDir = join(tmpdir(), "bubble-test-session-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("creates a new session and persists messages", () => {
    const file = join(tmpDir, "test.jsonl");
    const sm = new SessionManager(file);

    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).data.role).toBe("user");
    expect(JSON.parse(lines[1]).data.role).toBe("assistant");
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
      toolCalls: [{ id: "call_1", name: "ls", arguments: "{\"path\":\".\"}" }],
    });
    sm.appendMessage({ role: "tool", toolCallId: "call_1", content: "f package.json" });

    const restored = sm.getMessages();
    expect(restored).toHaveLength(2);
    expect(restored[0].role).toBe("user");
    expect(restored[1].role).toBe("assistant");
    expect((restored[1] as any).content).toBe("hi");
  });

  it("ignores corrupted jsonl lines gracefully", () => {
    const file = join(tmpDir, "corrupt.jsonl");
    const { writeFileSync } = require("node:fs");
    writeFileSync(file, '{"type":"message","data":{"role":"user"}}\nthis is not json\n', "utf-8");

    const sm = new SessionManager(file);
    const messages = sm.getMessages();
    expect(messages).toHaveLength(1);
  });
});
