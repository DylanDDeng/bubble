import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BubbleSdk, type Provider } from "../index.js";
import { Agent } from "../../agent.js";
import { SessionManager } from "../../session.js";
import { createSanitizedProviderError } from "../../provider-error-record.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe("PR76 SDK callback history fencing", () => {
  it.each(["mode", "error"])("cannot absorb a foreign clear through the %s callback", async callback => {
    const cwd = mkdtempSync(join(tmpdir(), "bubble-pr76-sdk-"));
    dirs.push(cwd);
    const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
    const provider: Provider = { async complete() { return "summary"; }, async *streamChat() { yield { type: "done" }; } };
    (sdk as any).resolveProvider = () => ({ provider, providerId: "openai", model: "openai:gpt-4o" });
    const id = `pr76-${callback}`;
    sdk.createSession({ id });
    const session = SessionManager.create(cwd, id + ".jsonl");
    session.appendMessage({ role: "user", content: "original" });
    session.appendMessage({ role: "assistant", content: "ack" });
    vi.spyOn(Agent.prototype, "run").mockImplementation(async function* (this: Agent) {
      const callbacks = this as any;
      const revision = callbacks.getContextRevision();
      new SessionManager(session.getSessionFile()).appendMarker("conversation_clear", "");
      const diagnostic = createSanitizedProviderError(new Error("failed"), {
        providerId: "test", modelId: "test", thinkingLevel: "off", messageCount: 1, toolCount: 0,
      });
      expect(() => callback === "mode" ? callbacks.onModeUpdate("plan") : callbacks.onProviderError(diagnostic)).toThrow("active turn");
      expect(callbacks.getContextRevision()).toBe(revision);
      expect(() => callbacks.onMessageAppend({ role: "assistant", content: "stale answer" })).toThrow("active turn");
      yield { type: "done" } as any;
    });
    for await (const _event of sdk.runTurn(id, { prompt: "next" })) { /* drain */ }
    expect(new SessionManager(session.getSessionFile()).getMessages()).toEqual([]);
  });
});
