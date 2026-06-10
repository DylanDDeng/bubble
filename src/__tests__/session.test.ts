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

  it("persists interrupted assistant message errors", () => {
    const file = join(tmpDir, "interrupted-assistant.jsonl");
    const sm1 = new SessionManager(file);
    sm1.appendMessage({
      role: "assistant",
      content: "Interrupted by user.",
      error: {
        name: "MessageAbortedError",
        message: "Assistant response was interrupted by the user.",
        aborted: true,
      },
    });

    const raw = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(raw.message.error).toMatchObject({ name: "MessageAbortedError", aborted: true });

    const sm2 = new SessionManager(file);
    expect(sm2.getMessages()[0]).toMatchObject({
      role: "assistant",
      error: { name: "MessageAbortedError", aborted: true },
    });
  });

  it("persists raw provider metadata without sanitizing it as display reasoning", () => {
    const file = join(tmpDir, "provider-metadata.jsonl");
    const sm1 = new SessionManager(file);
    const rawThinking = "normal before Runtime reminder:\nRepository orientation workflow:\n- keep raw signature text";
    sm1.appendMessage({
      role: "assistant",
      content: "Done.",
      reasoning: rawThinking,
      providerMetadata: {
        anthropic: {
          contentBlocks: [
            { type: "thinking", thinking: rawThinking, signature: "sig_raw" },
            {
              type: "text",
              text: [
                "Done. ",
                "<bubble_internal_reminder kind=\"system-reminder\">\n",
                "Permission mode is now: bypassPermissions.\n",
                "</bubble_internal_reminder>",
              ].join(""),
            },
          ],
        },
      },
    });

    const raw = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(raw.message.reasoning).not.toContain("Repository orientation workflow");
    expect(raw.message.providerMetadata.anthropic.contentBlocks[0].thinking).toContain("Repository orientation workflow");
    expect(raw.message.providerMetadata.anthropic.contentBlocks[0].signature).toBe("sig_raw");
    expect(raw.message.providerMetadata.anthropic.contentBlocks[1].text).toBe("Done. ");

    const sm2 = new SessionManager(file);
    const restored = sm2.getMessages()[0] as any;
    expect(restored.providerMetadata.anthropic.contentBlocks[0].thinking).toContain("Repository orientation workflow");
    expect(restored.providerMetadata.anthropic.contentBlocks[1].text).toBe("Done. ");
  });

  it("sanitizes leaked internal reminders from assistant content before persistence and restore", () => {
    const file = join(tmpDir, "assistant-content-sanitize.jsonl");
    const sm1 = new SessionManager(file);
    sm1.appendMessage({
      role: "assistant",
      content: [
        "before ",
        "<bubble_internal_reminder kind=\"system-reminder\">\n",
        "Permission mode is now: bypassPermissions.\n",
        "</bubble_internal_reminder>",
        " after",
      ].join(""),
    });

    const raw = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(raw.message.content).toBe("before  after");

    const sm2 = new SessionManager(file);
    const restored = sm2.getMessages()[0] as any;
    expect(restored.content).toBe("before  after");
    expect(restored.content).not.toContain("bubble_internal_reminder");
  });

  it("sanitizes memory citations from assistant content before persistence and restore", () => {
    const file = join(tmpDir, "assistant-memory-citation-sanitize.jsonl");
    const sm1 = new SessionManager(file);
    sm1.appendMessage({
      role: "assistant",
      content: [
        "Done.\n\n",
        "<oai-mem-citation>\n",
        "<citation_entries>\n",
        "/Users/example/.bubble/memories/MEMORY.md:1-2|note=[used memory]\n",
        "</citation_entries>\n",
        "<rollout_ids>\n",
        "</rollout_ids>\n",
        "</oai-mem-citation>",
      ].join(""),
    });

    const raw = JSON.parse(readFileSync(file, "utf-8").trim());
    expect(raw.message.content).toBe("Done.\n\n");
    expect(raw.message.content).not.toContain("oai-mem-citation");

    const sm2 = new SessionManager(file);
    const restored = sm2.getMessages()[0] as any;
    expect(restored.content).toBe("Done.\n\n");
    expect(restored.content).not.toContain("oai-mem-citation");
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

  it("keeps interrupted assistant boundaries after tool results when restoring messages", () => {
    const file = join(tmpDir, "interrupted-tool-turn.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "list files" });
    sm.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "bash", arguments: "{\"command\":\"ls\"}" }],
    });
    sm.appendMessage({ role: "tool", toolCallId: "call_1", content: "package.json" });
    sm.appendMessage({
      role: "assistant",
      content: "[model request interrupted before a final answer was produced: socket closed]",
    });

    const restored = sm.getMessages();
    expect(restored.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect((restored.at(-1) as any).content).toContain("model request interrupted");
    expect((restored.at(-1) as any).toolCalls).toBeUndefined();
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

  it("merges metadata updates without dropping session titles", () => {
    const file = join(tmpDir, "metadata-merge-title.jsonl");
    const sm = new SessionManager(file);
    sm.setMetadata({ cwd: "/tmp/project", title: "Fix resume titles", titleSource: "llm" });

    sm.updateMetadata({ model: "openai:gpt-5.4", thinkingLevel: "high" });

    expect(sm.getMetadata()).toMatchObject({
      cwd: "/tmp/project",
      title: "Fix resume titles",
      titleSource: "llm",
      model: "openai:gpt-5.4",
      thinkingLevel: "high",
    });
  });

  it("creates and reuses a persistent prompt cache key", () => {
    const file = join(tmpDir, "prompt-cache-key.jsonl");
    const sm1 = new SessionManager(file);
    const key = sm1.getOrCreatePromptCacheKey();

    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sm1.getOrCreatePromptCacheKey()).toBe(key);

    const sm2 = new SessionManager(file);
    expect(sm2.getOrCreatePromptCacheKey()).toBe(key);
  });

  it("clears generated title metadata", () => {
    const file = join(tmpDir, "metadata-clear-title.jsonl");
    const sm = new SessionManager(file);
    sm.setMetadata({
      cwd: "/tmp/project",
      title: "Old topic",
      titleSource: "llm",
      titleUpdatedAt: 123,
      titleUserMessageId: "entry-1",
    });

    sm.clearTitleMetadata();

    expect(sm.getMetadata().cwd).toBe("/tmp/project");
    expect(sm.getMetadata().title).toBeUndefined();
    expect(sm.getMetadata().titleSource).toBeUndefined();
    expect(sm.getMetadata().titleUpdatedAt).toBeUndefined();
    expect(sm.getMetadata().titleUserMessageId).toBeUndefined();
  });

  it("persists structured markers", () => {
    const file = join(tmpDir, "marker.jsonl");
    const sm = new SessionManager(file);
    sm.appendMarker("thinking_level_switch", "high");

    const line = readFileSync(file, "utf-8").trim();
    expect(JSON.parse(line).type).toBe("marker");
    expect(JSON.parse(line).kind).toBe("thinking_level_switch");
  });

  it("summarizes sessions with stored titles", () => {
    const cwd = join(tmpDir, "resume-title-project");
    const sm = SessionManager.create(cwd, "stored-title.jsonl");
    sm.updateMetadata({ cwd, title: "Resume picker title polish", titleSource: "llm" });
    sm.appendMessage({ role: "user", content: "please make resume sessions easier to scan" });

    const [summary] = SessionManager.summarizeSessionsForCwd(cwd);

    expect(summary.title).toBe("Resume picker title polish");
    expect(summary.preview).toBe("please make resume sessions easier to scan");
  });

  it("falls back to a pasted-content title for very long first messages", () => {
    const cwd = join(tmpDir, "resume-long-paste-project");
    const sm = SessionManager.create(cwd, "long-paste.jsonl");
    sm.updateMetadata({ cwd });
    sm.appendMessage({ role: "user", content: "x".repeat(1200) });

    const [summary] = SessionManager.summarizeSessionsForCwd(cwd);

    expect(summary.title).toBe("[Pasted text #1 +1200 chars]");
  });

  it("ignores generated titles anchored before a conversation clear marker", () => {
    const cwd = join(tmpDir, "resume-cleared-title-project");
    const sm = SessionManager.create(cwd, "cleared-title.jsonl");
    sm.updateMetadata({ cwd });
    sm.appendMessage({ role: "user", content: "old topic" });
    const firstUserId = sm.getEntries().find((entry) => entry.type === "user_message")!.id;
    sm.updateMetadata({
      title: "Old generated title",
      titleSource: "llm",
      titleUserMessageId: firstUserId,
    });
    sm.appendMarker("conversation_clear", "");
    sm.appendMessage({ role: "user", content: "new topic after clear" });

    const [summary] = SessionManager.summarizeSessionsForCwd(cwd);

    expect(summary.title).toBe("new topic after clear");
  });

  it("restores only messages after a conversation clear marker", () => {
    const file = join(tmpDir, "clear-marker.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "old task" });
    sm.appendMessage({ role: "assistant", content: "old answer" });
    sm.appendMarker("conversation_clear", "");
    sm.appendMessage({ role: "user", content: "new task" });

    const messages = sm.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect((messages[0] as any).content).toBe("new task");
  });

  it("does not restore summaries or todos from before a conversation clear marker", () => {
    const file = join(tmpDir, "clear-marker-summary-todos.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "old task" });
    sm.appendMessage({ role: "assistant", content: "old answer" });
    sm.appendCompaction("old summary");
    sm.appendTodosSnapshot([
      { content: "old todo", activeForm: "doing old todo", status: "pending" },
    ]);
    sm.appendMarker("conversation_clear", "");

    expect(sm.getMessages()).toEqual([]);
    expect(sm.getTodos()).toEqual([]);
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

  it("keeps generated entry ids unique after compaction", () => {
    const file = join(tmpDir, "compact-ids.jsonl");
    const sm = new SessionManager(file);
    sm.appendMessage({ role: "user", content: "task one" });
    sm.appendMessage({ role: "assistant", content: "reply one" });
    sm.appendMessage({ role: "user", content: "task two" });
    sm.appendMessage({ role: "assistant", content: "reply two" });
    sm.appendMessage({ role: "user", content: "task three" });
    sm.appendMessage({ role: "assistant", content: "reply three" });

    const result = sm.compact({ keepRecentTurns: 2 });
    expect(result.compacted).toBe(true);

    sm.appendMessage({ role: "user", content: "task four" });
    sm.appendMessage({ role: "assistant", content: "reply four" });

    const ids = readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("auto-compacts very long sessions while appending messages", () => {
    const file = join(tmpDir, "auto-compact.jsonl");
    const sm = new SessionManager(file);

    for (let i = 0; i < 110; i++) {
      sm.appendMessage({ role: "user", content: `task ${i}` });
      sm.appendMessage({ role: "assistant", content: `reply ${i}` });
    }

    const lines = readFileSync(file, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.some((line) => line.type === "summary")).toBe(true);
    expect(lines.length).toBeLessThan(220);
  });
});
