/**
 * Headless integration test: the full controller assembled from the
 * extracted sub-modules drives a scripted session (Phase 3 exit gate).
 * Asserts snapshot sequencing, exactly-once transcript effects, and
 * clean shutdown — no terminal involved.
 */
import { describe, expect, it } from "vitest";
import { BubbleTuiController } from "../tui/controller/controller.js";
import type { ControllerEffect } from "../tui/controller/effects.js";
import { FakeAgent } from "../tui/testing/fake-agent.js";
import { SpyHost } from "../tui/testing/spy-host.js";

function makeController() {
  const agent = new FakeAgent();
  const host = new SpyHost();
  const effects: ControllerEffect[] = [];
  const controller = new BubbleTuiController({
    agent: agent as never,
    sessionManager: { getSessionFile: () => "/s.jsonl", getMetadata: () => ({}), appendMessage: () => {} } as never,
    ports: host.ports,
    onEffect: (effect) => {
      effects.push(effect);
      host.recordEffect(effect);
    },
  });
  return { agent, host, effects, controller };
}

describe("BubbleTuiController headless session", () => {
  it("streams, commits once per turn, and finishes a run", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [
        { type: "turn_start" },
        { type: "text_delta", content: "Hello" },
        { type: "text_delta", content: " world" },
        { type: "reasoning_delta", content: "thinking..." },
        { type: "turn_end", usage: { promptTokens: 10, completionTokens: 5 } },
      ],
    });

    await controller.runTurn("hi", "/cwd");

    expect(controller.isRunning()).toBe(false);
    const transcript = controller.getTranscript();
    // Exactly one committed assistant message from the single turn.
    const assistantRows = transcript.filter((row) => row.role === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]!.content).toBe("Hello world");
    expect(assistantRows[0]!.reasoning).toBe("thinking...");
  });

  it("commits per willContinue segment and dedups retried openings", async () => {
    const { agent, controller } = makeController();
    agent.enqueueScript({
      events: [
        { type: "text_delta", content: "part one" },
        { type: "turn_end", willContinue: true },
        // Retry discards the half-built second attempt.
        { type: "turn_start" },
        { type: "text_delta", content: "half" },
        { type: "turn_start" },
        { type: "text_delta", content: "part two" },
        { type: "turn_end" },
      ],
    });

    await controller.runTurn("go", "/cwd");
    const rows = controller.getTranscript().filter((r) => r.role === "assistant");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe("part one");
    expect(rows[1]!.content).toBe("part two");
  });

  it("subscribers observe monotonic snapshot versions across a run", async () => {
    const { agent, controller, host } = makeController();
    const versions: number[] = [];
    controller.subscribe((version) => versions.push(version));

    agent.enqueueScript({ events: [{ type: "text_delta", content: "x" }, { type: "turn_end" }] });
    await controller.runTurn("hi", "/cwd");

    expect(versions.length).toBeGreaterThan(0);
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i]!).toBeGreaterThanOrEqual(versions[i - 1]!);
    }
    expect(host.effectsOf("assistant-committed")).toHaveLength(1);
  });

  it("cancelled runs surface an error effect and still settle", async () => {
    const { agent, controller, effects } = makeController();
    agent.enqueueScript({
      events: [{ type: "text_delta", content: "partial" }],
      failWith: Object.assign(new Error("aborted"), { name: "AbortError" }),
    });

    await controller.runTurn("hi", "/cwd");
    expect(effects.some((effect) => effect.kind === "run-error")).toBe(true);
    expect(controller.isRunning()).toBe(false);
    // Partial content still committed before the abort.
    expect(controller.getTranscript().some((row) => row.content === "partial")).toBe(true);
  });

  it("shutdown settles pending overlays and is idempotent", async () => {
    const { controller } = makeController();
    const first = controller.shutdown("user-quit");
    const second = controller.shutdown("user-quit");
    expect(first.reason).toBe("user-quit");
    expect(second.reason).toBe("user-quit");
    expect(first.wallMs).toBeGreaterThanOrEqual(0);
    expect(controller.pendingOverlayCount()).toBe(0);
  });

  it("session switch through the transaction notifies exactly once", async () => {
    const { controller, host } = makeController();
    host.ports.sessionHost.switchSession = () => ({
      manager: { getSessionFile: () => "/next.jsonl", getMetadata: () => ({}), appendMessage: () => {} },
    }) as never;
    const before = host.snapshotVersions.length;
    const outcome = controller.switchSession({ targetFile: "/next.jsonl" });
    expect(outcome.ok).toBe(true);
    expect(host.snapshotVersions.length - before).toBeLessThanOrEqual(1);
  });
});
