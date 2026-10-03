import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BubbleSdk, type AgentEvent, type Provider } from "../index.js";
import { SessionManager } from "../../session.js";

const cwd = mkdtempSync(join(tmpdir(), "bubble-sdk-checkpoint-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
function sdkWith(provider: Provider) {
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  (sdk as any).resolveProvider = () => ({ provider, providerId: "openai", model: "openai:gpt-4o" });
  return sdk;
}
function seed(sdk: BubbleSdk, id: string) {
  sdk.createSession({ id });
  const manager = SessionManager.create(cwd, id + ".jsonl");
  for (let i = 0; i < 6; i++) {
    manager.appendMessage({ role: "user", content: i === 0 ? "Do not change database" : `task ${i}` });
    manager.appendMessage({ role: "assistant", content: "investigation detail ".repeat(18000) });
  }
  return manager;
}

describe("SDK compaction commit and next-turn recovery", () => {
  it("publishes success only after durable commit and resumes identical history on a new SDK", async () => {
    const requests: Parameters<Provider["streamChat"]>[0][] = [];
    const provider: Provider = {
      async complete() { return "Decisions preserved. Next: verify. Do not change database."; },
      async *streamChat(messages) { requests.push(structuredClone(messages)); yield { type: "text", content: "done" }; yield { type: "done" }; },
    };
    const sdk = sdkWith(provider);
    const manager = seed(sdk, "checkpoint-resume");
    let completed = false;
    for await (const event of sdk.runTurn("checkpoint-resume", { prompt: "continue" })) {
      if (event.type === "context_compaction" && event.status === "completed") {
        completed = true;
        expect(event.persisted).toBe(true);
        expect(new SessionManager(manager.getSessionFile()).getEntries().some(entry => entry.type === "context_checkpoint" && entry.checkpoint.compactionId === event.compactionId)).toBe(true);
      }
    }
    expect(completed).toBe(true);
    const history = sdk.getHistory("checkpoint-resume");
    const reopened = sdkWith(provider);
    expect(reopened.getHistory("checkpoint-resume")).toEqual(history);
    for await (const _event of reopened.runTurn("checkpoint-resume", { prompt: "next task" })) { /* drain */ }
    expect(requests[1].some(message => typeof message.content === "string" && message.content.includes("Decisions preserved"))).toBe(true);
    expect(new SessionManager(manager.getSessionFile()).getEntries().filter(entry => entry.type === "user_message")).toHaveLength(8);
  });

  it("does not send or announce a candidate whose commit fails", async () => {
    let file = "";
    let requests = 0;
    const provider: Provider = {
      async complete() { writeFileSync(file + ".write-lock", `${process.pid}:live-test-owner`); return "valid summary"; },
      async *streamChat() { requests++; yield { type: "done" }; },
    };
    const sdk = sdkWith(provider);
    const manager = seed(sdk, "checkpoint-write-failure"); file = manager.getSessionFile();
    const events: AgentEvent[] = [];
    await expect((async () => { for await (const event of sdk.runTurn("checkpoint-write-failure", { prompt: "continue" })) events.push(event); })()).rejects.toThrow();
    expect(requests).toBe(0);
    expect(events.some(e => e.type === "context_compaction" && e.status === "completed")).toBe(false);
    expect(events.some(e => e.type === "context_compaction" && e.status === "failed")).toBe(true);
    expect(new SessionManager(file).getEntries().some(entry => entry.type === "context_checkpoint")).toBe(false);
  });
});
