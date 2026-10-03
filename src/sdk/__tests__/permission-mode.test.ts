import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BubbleSdk, type AgentEvent, type Provider } from "../index.js";
import type { PermissionMode } from "../../types.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "bubble-sdk-permission-mode-"));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

type Transcript = Parameters<Provider["streamChat"]>[0];

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

function contains(transcript: Transcript, needle: string): boolean {
  return transcript.some((message) => typeof message.content === "string" && message.content.includes(needle));
}

describe("BubbleSdk permission mode", () => {
  it.each<[PermissionMode, string]>([
    ["plan", "Plan mode is now ACTIVE"],
    ["bypassPermissions", "Permission mode is now: bypassPermissions"],
  ])("re-announces %s mode on every resumed turn", async (mode, reminder) => {
    const transcripts: Transcript[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        transcripts.push(messages);
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `mode-${mode}-${Date.now()}` });

    await collect(sdk.runTurn(session.id, { prompt: "first", mode }));
    await collect(sdk.runTurn(session.id, { prompt: "second", mode }));

    expect(transcripts).toHaveLength(2);
    expect(contains(transcripts[0], reminder)).toBe(true);
    expect(contains(transcripts[1], reminder)).toBe(true);
    // The deferred-tools advertisement is dropped by the same history reload.
    expect(contains(transcripts[0], "deferred tools are available via tool_search")).toBe(true);
    expect(contains(transcripts[1], "deferred tools are available via tool_search")).toBe(true);
  });

  it("keeps the previous turn's request as a stable cache prefix", async () => {
    const transcripts: Transcript[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        transcripts.push(messages.map((message) => ({ ...message })));
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `cache-prefix-${Date.now()}` });

    for (const prompt of ["one", "two", "three"]) {
      await collect(sdk.runTurn(session.id, { prompt, mode: "plan" }));
    }

    const key = (message: Transcript[number]) => `${message.role}:${JSON.stringify(message.content)}`;
    for (let turn = 1; turn < transcripts.length; turn++) {
      const previous = transcripts[turn - 1].map(key);
      const current = transcripts[turn].map(key);
      expect(current.slice(0, previous.length)).toEqual(previous);
    }
  });

  it("does not leak a plan reminder into a later default-mode turn", async () => {
    const transcripts: Transcript[] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        transcripts.push(messages);
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `mode-leak-${Date.now()}` });

    await collect(sdk.runTurn(session.id, { prompt: "first", mode: "plan" }));
    await collect(sdk.runTurn(session.id, { prompt: "second", mode: "default" }));

    expect(contains(transcripts[1], "Plan mode is now ACTIVE")).toBe(false);
  });

  async function approvePlan(planExitMode?: "default" | "bypassPermissions"): Promise<{
    events: AgentEvent[];
    toolResult: string;
  }> {
    let call = 0;
    let toolResult = "";
    const provider: Provider = {
      async *streamChat(messages) {
        call += 1;
        if (call === 1) {
          yield {
            type: "tool_call",
            id: "plan_1",
            name: "exit_plan_mode",
            arguments: JSON.stringify({ plan: "1. do the thing" }),
            isStart: true,
            isEnd: true,
          };
          yield { type: "done" };
          return;
        }
        const result = messages.find((message) => message.role === "tool");
        toolResult = typeof result?.content === "string" ? result.content : "";
        yield { type: "text", content: "done" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `plan-exit-${planExitMode ?? "none"}-${Date.now()}` });
    const events = await collect(sdk.runTurn(session.id, {
      prompt: "plan it",
      mode: "plan",
      ...(planExitMode ? { planExitMode } : {}),
      onPlanApproval: async () => true,
    }));
    return { events, toolResult };
  }

  it("re-entering plan after an approved plan puts the plan reminder after the old approval", async () => {
    const transcripts: Transcript[] = [];
    let call = 0;
    const provider: Provider = {
      async *streamChat(messages) {
        transcripts.push(messages.map((message) => ({ ...message })));
        call += 1;
        if (call === 2) {
          yield {
            type: "tool_call",
            id: "plan_1",
            name: "exit_plan_mode",
            arguments: JSON.stringify({ plan: "1. read" }),
            isStart: true,
            isEnd: true,
          };
          yield { type: "done" };
          return;
        }
        yield { type: "text", content: "ok" };
        yield { type: "done" };
      },
      async complete() { return ""; },
    };
    const sdk = sdkWithProvider(provider);
    const session = sdk.createSession({ id: `replan-${Date.now()}` });
    await collect(sdk.runTurn(session.id, { prompt: "hello", mode: "default" }));
    await collect(sdk.runTurn(session.id, { prompt: "plan it", mode: "plan", onPlanApproval: async () => true }));
    await collect(sdk.runTurn(session.id, { prompt: "plan again", mode: "plan" }));

    const last = transcripts[transcripts.length - 1];
    const text = (message: Transcript[number]) => typeof message.content === "string" ? message.content : "";
    const approvalIndex = last.findIndex((message) => text(message).includes("switched to default"));
    const planIndexes = last.flatMap((message, index) => text(message).includes("Plan mode is now ACTIVE") ? [index] : []);
    const defaultIndexes = last.flatMap((message, index) => text(message).includes("Permission mode is now: default") ? [index] : []);
    expect(approvalIndex).toBeGreaterThan(-1);
    // Exactly one live mode statement, the current one, after the stale approval.
    expect(planIndexes).toHaveLength(1);
    expect(planIndexes[0]).toBeGreaterThan(approvalIndex);
    expect(defaultIndexes).toEqual([]);
    expect(text(last[last.length - 1])).toBe("plan again");
  });

  function modeChanges(events: AgentEvent[]): string[] {
    return events
      .filter((event): event is Extract<AgentEvent, { type: "mode_changed" }> => event.type === "mode_changed")
      .map((event) => event.mode);
  }

  it("returns to default after plan approval when no exit mode is given", async () => {
    const { events, toolResult } = await approvePlan();
    expect(modeChanges(events)).toEqual(["default"]);
    expect(toolResult).toContain("switched to default");
  });

  it("restores the host's pre-plan mode after plan approval", async () => {
    const { events, toolResult } = await approvePlan("bypassPermissions");
    expect(modeChanges(events)).toEqual(["bypassPermissions"]);
    expect(toolResult).toContain("switched to bypassPermissions");
  });
});
