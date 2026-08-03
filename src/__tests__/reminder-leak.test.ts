/**
 * Regression tests for internal-reminder markup leaking into user-visible
 * surfaces after resume — the historical "<bubble_internal_*> shows up in the
 * session" bug, re-audited 2026-08-03.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatInternalContextBlock } from "../agent/internal-reminder-sanitizer.js";
import { compactMessages } from "../context/compact.js";
import { compactWithLLM } from "../context/llm-compactor.js";
import { SessionManager } from "../session.js";
import type { Message, Provider } from "../types.js";

let counter = 0;
function freshSession(): SessionManager {
  const dir = join(tmpdir(), `bubble-test-leak-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return new SessionManager(join(dir, "s.jsonl"));
}

const GOAL_KICK = formatInternalContextBlock("goal", "Goal: ship the feature\nContinue working.");

describe("reminder markup leak surfaces", () => {
  it("keeps harness-injected turns out of the /rewind picker", () => {
    const sm = freshSession();
    sm.appendMessage({ role: "user", content: "real question" });
    sm.appendMessage({ role: "assistant", content: "answer" });
    sm.appendMessage({ role: "user", content: GOAL_KICK });
    sm.appendMessage({ role: "assistant", content: "goal continuation" });

    const turns = sm.listUserTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0].preview).toBe("real question");
  });

  it("keeps harness-injected turns out of the /resume preview and title", () => {
    const home = join(tmpdir(), `bubble-test-leak-home-${Date.now()}-${counter++}`);
    const previousHome = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = home;
    try {
      const sm = SessionManager.create("/tmp/leak-project", "leak-session.jsonl");
      sm.appendMessage({ role: "user", content: GOAL_KICK });
      sm.appendMessage({ role: "assistant", content: "working on it" });
      sm.appendMessage({ role: "user", content: "please also add tests" });

      const summary = SessionManager.listAllSessions().find((s) => s.name === "leak-session");
      expect(summary).toBeDefined();
      expect(summary!.preview ?? "").not.toContain("bubble_internal");
      expect(summary!.title ?? "").not.toContain("bubble_internal");
      expect(`${summary!.preview}`).toContain("please also add tests");
    } finally {
      if (previousHome === undefined) delete process.env.BUBBLE_HOME;
      else process.env.BUBBLE_HOME = previousHome;
    }
  });

  it("scrubs reminder markup a compactor model echoes into its summary", async () => {
    const provider = {
      complete: async () =>
        `Progress so far.\n${formatInternalContextBlock("system-reminder", "stay on task")}\nNext: finish.`,
    } as unknown as Provider;
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "step 1" },
      { role: "assistant", content: "step 2" },
      { role: "assistant", content: "step 3" },
    ];

    const result = await compactWithLLM(messages, { provider, modelId: "m", keepRecentGroups: 1 });

    expect(result.compacted).toBe(true);
    expect(result.summary).not.toContain("bubble_internal");
    expect(JSON.stringify(result.messages)).not.toContain("bubble_internal_context");
  });

  it("keeps internal blocks out of the heuristic summary's goal line", () => {
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: GOAL_KICK },
      { role: "assistant", content: "kick handled" },
      { role: "user", content: "real goal statement" },
      { role: "assistant", content: "one" },
      { role: "user", content: "next" },
      { role: "assistant", content: "two" },
      { role: "user", content: "more" },
      { role: "assistant", content: "three" },
      { role: "user", content: "again" },
      { role: "assistant", content: "four" },
    ];

    const result = compactMessages(messages, { keepRecentTurns: 2 });

    expect(result.compacted).toBe(true);
    expect(result.summary).not.toContain("bubble_internal");
    // The goal kick is not a "real" user message: the pin lands on the first
    // REAL instruction instead, which survives verbatim outside the summary.
    const pinned = result.messages!.find(
      (message) => message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("real goal statement"),
    );
    expect(pinned).toBeDefined();
    expect(JSON.stringify(result.messages)).not.toContain("bubble_internal");
  });
});
