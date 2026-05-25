import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../session.js";
import { cleanGeneratedTitle, createSessionTitleUpdater } from "../session-title.js";
import type { Message, ProviderMessage, ThinkingLevel } from "../types.js";

describe("session title helpers", () => {
  const tmpDir = join(tmpdir(), "bubble-test-session-title-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("cleans generated titles to a single display-safe line", () => {
    expect(cleanGeneratedTitle("<think>notes</think>\n\"修复 resume 标题\"\nextra")).toBe("修复 resume 标题");
    expect(cleanGeneratedTitle("```text\nGood title\n```")).toBe("Good title");
  });

  it("generates a title after the first assistant message is persisted", async () => {
    const file = join(tmpDir, "title-after-assistant.jsonl");
    const sm = new SessionManager(file);
    const user: Message = { role: "user", content: "帮我优化 --resume 的 session 标题" };
    const assistant: Message = { role: "assistant", content: "可以。" };
    const calls: ProviderMessage[][] = [];
    const updater = createSessionTitleUpdater({
      sessionManager: sm,
      complete: async (messages, options?: { thinkingLevel?: ThinkingLevel }) => {
        calls.push(messages);
        expect(options?.thinkingLevel).toBe("off");
        return "Resume 会话标题优化";
      },
    });

    sm.appendMessage(user);
    updater.handlePersistedMessage(user);
    expect(sm.getMetadata().title).toBeUndefined();

    sm.appendMessage(assistant);
    updater.handlePersistedMessage(assistant);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(sm.getMetadata().title).toBe("Resume 会话标题优化");
    expect(sm.getMetadata().titleSource).toBe("llm");
  });

  it("does not write a generated title when the candidate was cleared", async () => {
    const file = join(tmpDir, "title-clear-race.jsonl");
    const sm = new SessionManager(file);
    const user: Message = { role: "user", content: "old topic" };
    const assistant: Message = { role: "assistant", content: "done" };
    const updater = createSessionTitleUpdater({
      sessionManager: sm,
      complete: async () => "Old generated title",
    });

    sm.appendMessage(user);
    updater.handlePersistedMessage(user);
    sm.appendMarker("conversation_clear", "");
    sm.appendMessage(assistant);
    updater.handlePersistedMessage(assistant);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sm.getMetadata().title).toBeUndefined();
  });
});
