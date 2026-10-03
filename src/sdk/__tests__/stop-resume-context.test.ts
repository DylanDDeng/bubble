import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BubbleSdk, type Provider, type AgentEvent, type RunTurnOptions } from "../index.js";

const cwd = mkdtempSync(join(tmpdir(), "bubble-stop-resume-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function makeSdk(provider: Provider): BubbleSdk {
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  (sdk as any).resolveProvider = () => ({ provider, providerId: "test", model: "test:model" });
  return sdk;
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const _event of events) { /* Observe terminal errors too. */ }
}

async function until(probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("SDK stop/resume context", () => {
  it("restores an input saved before runTurn without invoking a provider", async () => {
    let calls = 0;
    const provider: Provider = {
      async *streamChat() { calls++; yield { type: "done" }; },
      async complete() { return ""; },
    };
    const sdk = makeSdk(provider);
    const session = sdk.createSession();
    const prompt = [
      { type: "text" as const, text: "accepted before SDK execution" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,fixture" } },
    ];
    sdk.recordInterruptedInput(session.id, prompt);
    const restored = makeSdk(provider);
    expect(restored.listSessions().some(s => s.name === session.id)).toBe(true);
    expect(restored.getHistory(session.id).filter(m => m.role === "user")).toEqual([{ role: "user", content: prompt }]);
    expect(calls).toBe(0);
    await restored.deleteSession(session.id);
    expect(() => restored.recordInterruptedInput(session.id, "must not resurrect")).toThrow(/active or deleted/);
  });

  it("cancels a reserved turn without promoting queued work and preserves only its input", async () => {
    let calls = 0;
    const sdk = makeSdk({
      async *streamChat() {
        calls++;
        yield { type: "done" };
      },
      async complete() { return ""; },
    });
    const session = sdk.createSession();
    const first = drain(sdk.runTurn(session.id, { prompt: "original", preserveInterruptedInput: true })).catch(error => error);
    const queued = drain(sdk.runTurn(session.id, { prompt: "queued", preserveInterruptedInput: true })).catch(error => error);
    await expect(sdk.stopAndWait(session.id, { cancelQueued: true })).resolves.toBe(2);
    await Promise.all([first, queued]);
    expect(calls).toBe(0);
    expect(sdk.getSessionRunState(session.id)).toMatchObject({ active: false, queuedTurns: 0, phase: "idle" });
    expect(sdk.getHistory(session.id).filter(m => m.role === "user")).toEqual([{ role: "user", content: "original" }]);
  });

  it("waits for delayed abort cleanup and publishes the terminal before returning", async () => {
    let entered = false;
    let cleanupStarted = false;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const sdk = makeSdk({
      async *streamChat(_messages, options) {
        entered = true;
        yield { type: "text", content: "partial progress" };
        await new Promise<void>((_resolve, reject) => {
          const abort = async () => {
            cleanupStarted = true;
            await cleanup;
            reject(options.abortSignal?.reason);
          };
          if (options.abortSignal?.aborted) void abort();
          else options.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
      async complete() { return ""; },
    });
    const session = sdk.createSession();
    const handle = sdk.openSession(session.id);
    const run = drain(sdk.runTurn(session.id, { prompt: "original task", preserveInterruptedInput: true })).catch(error => error);
    await until(() => entered);
    let stopped = false;
    const stop = sdk.stopAndWait(session.id, { cancelQueued: true }).then(() => { stopped = true; });
    await until(() => cleanupStarted);
    expect(stopped).toBe(false);
    release();
    await stop;
    await run;
    expect(sdk.getSessionRunState(session.id).active).toBe(false);
    const stream = handle.eventsFrom(handle.latestSequence - 1)[Symbol.asyncIterator]();
    expect((await stream.next()).value.terminal.kind).toBe("cancelled");
    handle.close();
    expect(JSON.stringify(sdk.getHistory(session.id))).toContain("partial progress");
    expect(sdk.getHistory(session.id).filter(m => m.role === "user")).toHaveLength(1);
  });

  it("persists setup-interrupted input with attachments for a new SDK instance, but discards queued inputs", async () => {
    const requests: unknown[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        requests.push(JSON.parse(JSON.stringify(messages)));
        yield { type: "text", content: "continued" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = makeSdk(provider);
    let entered = false;
    (sdk as any).resolveProjectTrust = async (_cwd: string, _options: RunTurnOptions, signal: AbortSignal) => {
      entered = true;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const session = sdk.createSession();
    const prompt = [
      { type: "text" as const, text: "Original image task" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,fixture" } },
    ];
    const first = drain(sdk.runTurn(session.id, { prompt, preserveInterruptedInput: true })).catch(error => error);
    await until(() => entered);
    const queued = drain(sdk.runTurn(session.id, { prompt: "discard this queued task", preserveInterruptedInput: true })).catch(error => error);
    await sdk.stopAndWait(session.id, { cancelQueued: true });
    await Promise.all([first, queued]);
    expect(sdk.listSessions().some(s => s.name === session.id)).toBe(true);
    const reloaded = makeSdk(provider);
    expect(reloaded.getHistory(session.id).filter(m => m.role === "user")).toEqual([{ role: "user", content: prompt }]);
    await drain(reloaded.runTurn(session.id, { prompt: "continue" }));
    const text = JSON.stringify(requests);
    expect(text).toContain("Original image task");
    expect(text).toContain("data:image/png;base64,fixture");
    expect(text).not.toContain("discard this queued task");
  });
});
