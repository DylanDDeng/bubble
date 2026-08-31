import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BubbleSdk,
  type AgentEvent,
  type Provider,
  type SdkSessionEvent,
} from "../index.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "bubble-sdk-turn-control-"));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sdkWithProvider(provider: Provider): BubbleSdk {
  const sdk = new BubbleSdk({ defaultCwd: temporaryDirectory, mcp: false });
  const target = sdk as unknown as {
    resolveProvider: () => { provider: Provider; providerId: string; model: string };
  };
  target.resolveProvider = () => ({ provider, providerId: "test", model: "test:model" });
  return sdk;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function latestUserText(messages: Parameters<Provider["streamChat"]>[0]): string {
  const latest = [...messages].reverse().find((message) => message.role === "user");
  return typeof latest?.content === "string" ? latest.content : "content-parts";
}

async function until(
  probe: () => boolean,
  message = "condition not met in time",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("BubbleSdk turn control", () => {
  it("reserves eagerly, accepts setup-time steer, and stops before consumption", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `pre-consumption-${Date.now()}` });
    const stream = sdk.runTurn(session.id, { prompt: "initial" });

    expect(sdk.getSessionRunState(session.id)).toMatchObject({ active: true, phase: "reserved" });
    const steer = sdk.steer(session.id, "accepted during setup");
    expect(steer.accepted).toBe(true);
    sdk.stop(session.id);

    if (!steer.accepted) throw new Error("expected accepted steer");
    await expect(steer.outcome).resolves.toMatchObject({
      type: "input_rejected",
      reason: "turn_cancelled",
      content: "accepted during setup",
    });
    // The cancellation receipt is delivered as an event before the stream rejects.
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "input_rejected", reason: "turn_cancelled", content: "accepted during setup" },
    });
    await expect(stream.next()).rejects.toThrow("SDK turn stopped");
    expect(sdk.getSessionRunState(session.id)).toEqual({
      active: false,
      queuedTurns: 0,
      pendingSteers: 0,
      phase: "idle",
    });
  });

  it("auto-queues an unapplied steer into a follow-up turn that runs it", async () => {
    const entered = deferred();
    const finish = deferred();
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        if (prompt === "initial") {
          entered.resolve();
          await finish.promise;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `steer-queue-${Date.now()}` });
    const eventsPromise = collect(sdk.runTurn(session.id, { prompt: "initial" }));
    await entered.promise;
    const steer = sdk.steer(session.id, "new constraint");
    if (!steer.accepted || steer.disposition !== "steered") throw new Error("expected steered input");
    finish.resolve();

    const events = await eventsPromise;
    // The accepted-but-unapplied steer is not lost: it becomes a queued turn.
    const outcome = await steer.outcome;
    expect(outcome).toMatchObject({ type: "input_queued", content: "new constraint" });
    const marker = events.find((event) => event.type === "input_queued" && event.id === steer.input.id);
    expect(marker).toMatchObject({ turnId: expect.any(String) });
    // The pump drives the follow-up turn even though nobody subscribed to it.
    await until(() => prompts.includes("new constraint"), "follow-up turn never ran the steer content");
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");
  });

  it("auto-starts a turn when steering an idle session", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `steer-idle-${Date.now()}` });

    const steer = sdk.steer(session.id, "start working");
    expect(steer).toMatchObject({ accepted: true, disposition: "queued" });
    if (!steer.accepted) throw new Error("expected accepted steer");
    await expect(steer.outcome).resolves.toMatchObject({ type: "input_queued", content: "start working" });
    await until(() => prompts.includes("start working"), "idle steer never started a turn");
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");
    expect(sdk.getHistory(session.id).some((m) => m.role === "user" && m.content === "start working")).toBe(true);
  });

  it("resolves an applied steer before the continuation provider call", async () => {
    const entered = deferred();
    const release = deferred();
    let call = 0;
    const provider: Provider = {
      async *streamChat() {
        if (call++ === 0) {
          entered.resolve();
          await release.promise;
          yield {
            type: "tool_call",
            id: "unknown-tool",
            name: "not_a_real_tool",
            arguments: "{}",
            isStart: true,
            isEnd: true,
          };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "continued" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `applied-${Date.now()}` });
    const eventsPromise = collect(sdk.runTurn(session.id, { prompt: "initial" }));
    await entered.promise;
    const steer = sdk.steer(session.id, "apply on continuation");
    if (!steer.accepted) throw new Error("expected accepted steer");
    release.resolve();

    const [events, outcome] = await Promise.all([eventsPromise, steer.outcome]);
    expect(outcome).toMatchObject({ type: "input_applied", id: steer.input.id });
    expect(events.filter((event) => event.type === "input_applied" && event.id === steer.input.id)).toHaveLength(1);
  });

  it("reports cancellation when stop happens while the consumer is suspended at a yield", async () => {
    const provider: Provider = {
      async *streamChat(_messages, options) {
        yield { type: "text", content: "pause here" };
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(options.abortSignal?.reason);
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener("abort", fail, { once: true });
        });
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `yield-stop-${Date.now()}` });
    const stream = sdk.runTurn(session.id, { prompt: "initial" });

    let event = await stream.next();
    while (!event.done && event.value.type !== "text_delta") event = await stream.next();
    const steer = sdk.steer(session.id, "do not lose me");
    if (!steer.accepted) throw new Error("expected accepted steer");
    sdk.stop(session.id);

    await expect(steer.outcome).resolves.toMatchObject({
      type: "input_rejected",
      id: steer.input.id,
      reason: "turn_cancelled",
    });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "input_rejected", reason: "turn_cancelled", content: "do not lose me" },
    });
    await expect(stream.next()).rejects.toThrow("SDK turn stopped");
    expect(sdk.getSessionRunState(session.id).active).toBe(false);
  });

  it("keeps the turn running and auto-queues the steer when the consumer returns early", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        yield { type: "text", content: "first chunk" };
        yield { type: "text", content: "second chunk" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `early-return-${Date.now()}` });
    const stream = sdk.runTurn(session.id, { prompt: "initial" });
    let event = await stream.next();
    while (!event.done && event.value.type !== "text_delta") event = await stream.next();
    const steer = sdk.steer(session.id, "preserve outcome");
    if (!steer.accepted) throw new Error("expected accepted steer");

    // Detaching the subscriber no longer cancels the turn: execution is pump-driven.
    await stream.return(undefined);
    await expect(steer.outcome).resolves.toMatchObject({ type: "input_queued", content: "preserve outcome" });
    await until(() => prompts.includes("preserve outcome"), "early return lost the queued steer");
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");
  });

  it("classifies provider failure separately from cancellation", async () => {
    const entered = deferred();
    const fail = deferred();
    const provider: Provider = {
      async *streamChat() {
        entered.resolve();
        await fail.promise;
        throw new Error("provider failed");
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `failure-${Date.now()}` });
    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const event of sdk.runTurn(session.id, { prompt: "initial" })) events.push(event);
    })();
    await entered.promise;
    const steer = sdk.steer(session.id, "retry next turn");
    if (!steer.accepted) throw new Error("expected accepted steer");
    fail.resolve();

    await expect(run).rejects.toThrow("provider failed");
    await expect(steer.outcome).resolves.toMatchObject({ type: "input_rejected", reason: "turn_failed" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "input_rejected",
      id: steer.input.id,
      reason: "turn_failed",
    }));
  });

  it("settles a setup-time steer when provider resolution fails", async () => {
    const provider: Provider = {
      async *streamChat() { yield { type: "done" }; },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    (sdk as unknown as { resolveProvider(): never }).resolveProvider = () => {
      throw new Error("provider setup failed");
    };
    const session = sdk.createSession({ id: `setup-failure-${Date.now()}` });
    const stream = sdk.runTurn(session.id, { prompt: "initial" });
    const steer = sdk.steer(session.id, "accepted before setup");
    if (!steer.accepted) throw new Error("expected accepted steer");

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "input_rejected", reason: "turn_failed" },
    });
    await expect(stream.next()).rejects.toThrow("provider setup failed");
    await expect(steer.outcome).resolves.toMatchObject({
      type: "input_rejected",
      reason: "turn_failed",
      content: "accepted before setup",
    });
  });

  it("closes a suspended stream and settles steer on external abort", async () => {
    const provider: Provider = {
      async *streamChat(_messages, options) {
        yield { type: "text", content: "suspend" };
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(options.abortSignal?.reason);
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener("abort", fail, { once: true });
        });
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `external-abort-${Date.now()}` });
    const abort = new AbortController();
    const stream = sdk.runTurn(session.id, { prompt: "initial", signal: abort.signal });
    let event = await stream.next();
    while (!event.done && event.value.type !== "text_delta") event = await stream.next();
    const steer = sdk.steer(session.id, "cancel me");
    if (!steer.accepted) throw new Error("expected accepted steer");

    abort.abort(new Error("host aborted"));
    await expect(steer.outcome).resolves.toMatchObject({ type: "input_rejected", reason: "turn_cancelled" });
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { type: "input_rejected", reason: "turn_cancelled", content: "cancel me" },
    });
    await expect(stream.next()).rejects.toThrow("host aborted");
    expect(sdk.getSessionRunState(session.id).phase).toBe("idle");
  });

  it("queues FIFO, clears queued turns directly, and keeps the active turn running", async () => {
    const entered = deferred();
    const release = deferred();
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        if (prompt === "first") {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `clear-queue-${Date.now()}` });
    const first = collect(sdk.runTurn(session.id, { prompt: "first" }));
    await entered.promise;
    const secondStream = sdk.enqueueTurn(session.id, { prompt: "second" });

    expect(sdk.getSessionRunState(session.id)).toMatchObject({ active: true, queuedTurns: 1 });
    expect(sdk.clearQueue(session.id)).toBe(1);
    await expect(secondStream.next()).rejects.toThrow("Queued SDK turn cancelled");
    expect(sdk.getSessionRunState(session.id)).toMatchObject({ active: true, queuedTurns: 0 });
    release.resolve();
    await first;
    expect(prompts).toEqual(["first"]);
  });

  it("runs different sessions concurrently", async () => {
    const enteredA = deferred();
    const enteredB = deferred();
    const release = deferred();
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        if (prompt === "a") enteredA.resolve();
        if (prompt === "b") enteredB.resolve();
        await release.promise;
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const a = sdk.createSession({ id: `parallel-a-${Date.now()}` });
    const b = sdk.createSession({ id: `parallel-b-${Date.now()}` });
    const runA = collect(sdk.runTurn(a.id, { prompt: "a" }));
    const runB = collect(sdk.runTurn(b.id, { prompt: "b" }));

    await Promise.all([enteredA.promise, enteredB.promise]);
    expect(sdk.getSessionRunState(a.id).phase).toBe("active");
    expect(sdk.getSessionRunState(b.id).phase).toBe("active");
    release.resolve();
    await Promise.all([runA, runB]);
  });

  it("deletes only after active teardown and cannot resurrect the JSONL file", async () => {
    const entered = deferred();
    const provider: Provider = {
      async *streamChat(_messages, options) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(options.abortSignal?.reason);
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener("abort", fail, { once: true });
        });
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `delete-active-${Date.now()}` });
    const run = collect(sdk.runTurn(session.id, { prompt: "persisted prompt" }));
    await entered.promise;
    const history = sdk.getHistory(session.id);
    expect(history.length).toBeGreaterThan(0);
    const indexed = (sdk as unknown as { resolveSession(id: string): { manager: { getSessionFile(): string } } }).resolveSession(session.id);
    const sessionFile = indexed.manager.getSessionFile();
    expect(existsSync(sessionFile)).toBe(true);

    const deletion = sdk.deleteSession(session.id);
    await expect(run).rejects.toThrow("SDK session deleted");
    await deletion;
    // Poll a real macrotask window: no late async write may resurrect the file.
    const deadline = Date.now() + 200;
    while (Date.now() < deadline) {
      expect(existsSync(sessionFile)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(sessionFile)).toBe(false);
    expect(sdk.getSessionRunState(session.id).phase).toBe("deleted");
    expect(() => sdk.runTurn(session.id, { prompt: "resurrect" })).toThrow("Unknown session");
  });

  it("completes deletion while a subscriber remains suspended mid-replay", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "text", content: "suspend consumer" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `delete-at-yield-${Date.now()}` });
    // Drive a full turn with no subscriber at all.
    const stream = sdk.runTurn(session.id, { prompt: "initial" });
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");

    // Subscribe to the session log and consume exactly one buffered event.
    const handle = sdk.openSession(session.id);
    const subscription = handle.events[Symbol.asyncIterator]();
    const first = await subscription.next();
    expect(first.done).toBe(false);

    await sdk.deleteSession(session.id);
    expect(sdk.getSessionRunState(session.id).phase).toBe("deleted");
    // Deletion did not wait on the suspended subscriber, and the released
    // log lets the subscription drain to completion instead of hanging.
    const drained: SdkSessionEvent[] = [];
    while (true) {
      const next = await subscription.next();
      if (next.done) break;
      drained.push(next.value);
    }
    handle.close();
    expect(drained.length).toBeGreaterThan(0);
    // The unconsumed runTurn stream drains its buffered events and ends.
    const replayed = await collect(stream);
    expect(replayed.length).toBeGreaterThan(0);
  });

  it("deletes an unconsumed reserved turn without waiting forever", async () => {
    const provider: Provider = {
      async *streamChat() { yield { type: "done" }; },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `delete-reserved-${Date.now()}` });
    const stream = sdk.runTurn(session.id, { prompt: "never consumed" });

    await sdk.deleteSession(session.id);
    await expect(stream.next()).rejects.toThrow("SDK session deleted");
    expect(sdk.getSessionRunState(session.id).phase).toBe("deleted");
  });

  it("keeps queued turns across stop() and clears them with cancelQueued", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        if (prompt === "first") {
          // Block until aborted so the active turn is deterministic.
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(options.abortSignal?.reason);
            if (options.abortSignal?.aborted) fail();
            else options.abortSignal?.addEventListener("abort", fail, { once: true });
          });
          return;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const keepSession = sdk.createSession({ id: `stop-keep-${Date.now()}` });
    const first = collect(sdk.runTurn(keepSession.id, { prompt: "first" }));
    void first.catch(() => undefined); // the stopped stream rejects; drain promptly
    await until(() => prompts.includes("first"));
    sdk.enqueueTurn(keepSession.id, { prompt: "survivor" });
    // Default stop is Claude-style: interrupt the active turn, keep the queue.
    expect(sdk.stop(keepSession.id)).toBe(1);
    expect(sdk.getSessionRunState(keepSession.id)).toMatchObject({ queuedTurns: 1 });
    await until(() => prompts.includes("survivor"), "queued turn did not survive stop()");
    await until(() => sdk.getSessionRunState(keepSession.id).phase === "idle");
    await first.catch(() => undefined);

    const clearSession = sdk.createSession({ id: `stop-clear-${Date.now()}` });
    const second = collect(sdk.runTurn(clearSession.id, { prompt: "first" }));
    void second.catch(() => undefined); // the stopped stream rejects; drain promptly
    await until(() => prompts.filter((prompt) => prompt === "first").length >= 2);
    const cancelledStream = sdk.enqueueTurn(clearSession.id, { prompt: "doomed" });
    expect(sdk.stop(clearSession.id, { cancelQueued: true })).toBe(2);
    await until(() => sdk.getSessionRunState(clearSession.id).phase === "idle");
    expect(sdk.getSessionRunState(clearSession.id)).toMatchObject({ active: false, queuedTurns: 0 });
    await expect(cancelledStream.next()).rejects.toThrow(/SDK turn/);
    await second.catch(() => undefined);
    expect(prompts).not.toContain("doomed");
  });

  it("replays session events from sequence 1 and reconnects from the last seen sequence", async () => {
    const provider: Provider = {
      async *streamChat() {
        yield { type: "text", content: "hello" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `replay-${Date.now()}` });
    await collect(sdk.runTurn(session.id, { prompt: "initial" }));
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");

    // A fresh handle replays everything the session produced, in order. The
    // session log stays open for reconnects, so read until the turn ends.
    const handle = sdk.openSession(session.id);
    const replay: SdkSessionEvent[] = [];
    for await (const item of handle.events) {
      replay.push(item);
      if (item.event.type === "turn_end") break;
    }
    handle.close();
    expect(replay.length).toBeGreaterThan(1);
    const sequences = replay.map((item) => item.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(replay.map((item) => item.sessionId))).toEqual(new Set([session.id]));
    expect(replay.some((item) => item.event.type === "text_delta")).toBe(true);

    // Reconnect skips durably processed events.
    const resumed: SdkSessionEvent[] = [];
    for await (const item of handle.eventsFrom(2)) {
      resumed.push(item);
      if (item.event.type === "turn_end") break;
    }
    handle.close();
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed[0]!.sequence).toBe(3);
    const tail = replay.slice(replay.findIndex((item) => item.sequence === resumed[0]!.sequence));
    expect(resumed.map((item) => item.sequence)).toEqual(tail.map((item) => item.sequence));
  });

  it("routes a second SDK instance's calls to the instance running the session", async () => {
    const prompts: string[] = [];
    const entered = deferred();
    const release = deferred();
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        if (prompt === "owned turn") {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const owner = sdkWithProvider(provider);
    const session = owner.createSession({ id: `routed-${Date.now()}` });

    // The owner holds an active turn on the session.
    void collect(owner.runTurn(session.id, { prompt: "owned turn" }));
    await entered.promise;

    // The second instance has no working provider: if it executed this
    // session itself, its turn would fail — success proves routing to owner.
    const bystander = new BubbleSdk({ defaultCwd: temporaryDirectory, mcp: false });
    (bystander as unknown as { resolveProvider(): never }).resolveProvider = () => {
      throw new Error("bystander must not execute this session");
    };
    const routed = collect(bystander.runTurn(session.id, { prompt: "routed run" }));
    // A steer from the bystander lands in the owner's active turn.
    const steer = bystander.steer(session.id, "routed steer");
    expect(steer).toMatchObject({ accepted: true, disposition: "steered" });
    release.resolve();

    const routedEvents = await routed;
    expect(routedEvents.some((event) => event.type === "text_delta")).toBe(true);
    await until(() => prompts.includes("routed steer"), "routed steer never applied");
    await until(() => bystander.getSessionRunState(session.id).phase === "idle");
    expect(prompts).toContain("routed run");
  });

  it("lets another instance take over once the owner goes idle", async () => {
    const prompts: string[] = [];
    const makeProvider = (): Provider => ({
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    });
    const first = sdkWithProvider(makeProvider());
    const second = sdkWithProvider(makeProvider());
    const session = first.createSession({ id: `handover-${Date.now()}` });

    await collect(first.runTurn(session.id, { prompt: "by first" }));
    await until(() => first.getSessionRunState(session.id).phase === "idle");
    // Ownership is released at idle, so the second instance claims it itself.
    await collect(second.runTurn(session.id, { prompt: "by second" }));
    await until(() => second.getSessionRunState(session.id).phase === "idle");
    expect(prompts).toEqual(["by first", "by second"]);
  });

  it("routes a second instance to a session that has not been persisted yet", async () => {
    const entered = deferred();
    const release = deferred();
    const provider: Provider = {
      async *streamChat(messages) {
        const prompt = latestUserText(messages);
        if (prompt === "owned turn") {
          entered.resolve();
          await release.promise;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const owner = sdkWithProvider(provider);
    const session = owner.createSession({ id: `fresh-route-${Date.now()}` });
    void collect(owner.runTurn(session.id, { prompt: "owned turn" }));
    await entered.promise;

    // No JSONL exists on disk yet; the process-level location registry still
    // routes the bystander to the running owner instead of unknown_session.
    const bystander = new BubbleSdk({ defaultCwd: temporaryDirectory, mcp: false });
    (bystander as unknown as { resolveProvider(): never }).resolveProvider = () => {
      throw new Error("bystander must not execute this session");
    };
    expect(bystander.steer(session.id, "find the owner")).toMatchObject({
      accepted: true,
      disposition: "steered",
    });
    release.resolve();
    await until(() => owner.getSessionRunState(session.id).phase === "idle");
  });

  it("settles an accepted steer when the session is deleted mid-turn", async () => {
    const entered = deferred();
    const provider: Provider = {
      async *streamChat(_messages, options) {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const fail = () => reject(options.abortSignal?.reason);
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener("abort", fail, { once: true });
        });
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `delete-steer-${Date.now()}` });
    const run = collect(sdk.runTurn(session.id, { prompt: "initial" }));
    void run.catch(() => undefined);
    await entered.promise;
    const steer = sdk.steer(session.id, "settle me on delete");
    if (!steer.accepted) throw new Error("expected accepted steer");

    await sdk.deleteSession(session.id);
    await expect(steer.outcome).resolves.toMatchObject({
      type: "input_rejected",
      reason: "turn_cancelled",
      content: "settle me on delete",
    });
    expect(sdk.getSessionRunState(session.id).phase).toBe("deleted");
  });

  it("queues a steer that arrives after stop seals the active turn", async () => {
    const prompts: string[] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        const prompt = latestUserText(messages);
        prompts.push(prompt);
        if (prompt === "initial") {
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(options.abortSignal?.reason);
            if (options.abortSignal?.aborted) fail();
            else options.abortSignal?.addEventListener("abort", fail, { once: true });
          });
          return;
        }
        yield { type: "text", content: prompt };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `post-stop-${Date.now()}` });
    const run = collect(sdk.runTurn(session.id, { prompt: "initial" }));
    void run.catch(() => undefined);
    await until(() => prompts.includes("initial"));

    sdk.stop(session.id);
    // The active turn is sealed but still settling: the steer must not be
    // dropped into it, and must not be lost — it becomes the next turn.
    const steer = sdk.steer(session.id, "queued after stop");
    expect(steer).toMatchObject({ accepted: true, disposition: "queued" });
    await until(() => prompts.includes("queued after stop"), "post-stop steer never ran");
    await until(() => sdk.getSessionRunState(session.id).phase === "idle");
  });

  it("marks turn failure and cancellation with terminal records on the session log", async () => {
    const failSession = (() => {
      const entered = deferred();
      const provider: Provider = {
        async *streamChat() {
          entered.resolve();
          throw new Error("provider exploded");
        },
        async complete() { return ""; },
      };
      return { provider, entered };
    })();
    const failSdk = sdkWithProvider(failSession.provider);
    const failing = failSdk.createSession({ id: `terminal-fail-${Date.now()}` });
    const failHandle = failSdk.openSession(failing.id);
    const failRun = collect(failSdk.runTurn(failing.id, { prompt: "doom" }));
    void failRun.catch(() => undefined);
    await failSession.entered.promise;

    const cancelSession = (() => {
      const entered = deferred();
      const provider: Provider = {
        async *streamChat(_messages, options) {
          entered.resolve();
          await new Promise<void>((_resolve, reject) => {
            const fail = () => reject(options.abortSignal?.reason);
            if (options.abortSignal?.aborted) fail();
            else options.abortSignal?.addEventListener("abort", fail, { once: true });
          });
        },
        async complete() { return ""; },
      };
      return { provider, entered };
    })();
    const cancelSdk = sdkWithProvider(cancelSession.provider);
    const cancelling = cancelSdk.createSession({ id: `terminal-cancel-${Date.now()}` });
    const cancelHandle = cancelSdk.openSession(cancelling.id);
    const cancelRun = collect(cancelSdk.runTurn(cancelling.id, { prompt: "block" }));
    void cancelRun.catch(() => undefined);
    await cancelSession.entered.promise;
    cancelSdk.stop(cancelling.id);

    const readTerminal = async (
      iterable: AsyncIterable<SdkSessionEvent>,
    ): Promise<SdkSessionEvent> => {
      for await (const item of iterable) {
        if (item.terminal) return item;
      }
      throw new Error("session log never produced a terminal record");
    };
    const [failed, cancelled] = await Promise.all([
      readTerminal(failHandle.events),
      readTerminal(cancelHandle.events),
    ]);
    failHandle.close();
    cancelHandle.close();
    expect(failed).toMatchObject({
      sessionId: failing.id,
      event: { type: "turn_end" },
      terminal: { kind: "failed", message: "provider exploded" },
    });
    expect(cancelled).toMatchObject({
      sessionId: cancelling.id,
      event: { type: "turn_end", willContinue: false },
      terminal: { kind: "cancelled" },
    });
  });
});
