import { describe, expect, it } from "vitest";
import {
  MIN_LOOP_INTERVAL_MS,
  decideLoopFiring,
  formatInterval,
  formatLoopList,
  parseLoopCommand,
  type LoopState,
} from "../loop/engine.js";

function loop(overrides: Partial<LoopState>): LoopState {
  return { id: 1, prompt: "check CI", intervalMs: 300_000, nextFireAt: 0, fires: 0, ...overrides };
}

describe("parseLoopCommand", () => {
  it("parses intervals with units and enforces the 60s floor", () => {
    expect(parseLoopCommand("/loop 5m check CI")).toMatchObject({ action: "start", intervalMs: 300_000, prompt: "check CI" });
    expect(parseLoopCommand("/loop 2h poll deploy")).toMatchObject({ action: "start", intervalMs: 7_200_000 });
    expect(parseLoopCommand("/loop 90s watch tests")).toMatchObject({ action: "start", intervalMs: 90_000 });
    expect(parseLoopCommand("/loop 10s too fast")).toMatchObject({ action: "start", intervalMs: MIN_LOOP_INTERVAL_MS });
  });

  it("parses list, stop, stop <id>, and bare /loop as help", () => {
    expect(parseLoopCommand("/loop list")).toEqual({ action: "list" });
    expect(parseLoopCommand("/loop stop")).toEqual({ action: "stop", stopId: undefined });
    expect(parseLoopCommand("/loop stop 3")).toEqual({ action: "stop", stopId: 3 });
    expect(parseLoopCommand("/loop")).toEqual({ action: "help" });
  });

  it("rejects malformed intervals with usage guidance", () => {
    expect(parseLoopCommand("/loop every5min do things").error).toContain("Usage");
    expect(parseLoopCommand("/loop 5x do things").error).toContain("Usage");
  });
});

describe("decideLoopFiring", () => {
  it("waits before due, fires when idle, defers when a turn runs", () => {
    const due = loop({ nextFireAt: 1000 });
    expect(decideLoopFiring(due, 999, false)).toBe("wait");
    expect(decideLoopFiring(due, 1000, false)).toBe("fire");
    expect(decideLoopFiring(due, 1000, true)).toBe("defer");
  });
});

describe("formatting", () => {
  it("formats intervals compactly", () => {
    expect(formatInterval(300_000)).toBe("5m");
    expect(formatInterval(3_600_000)).toBe("1h");
    expect(formatInterval(90_000)).toBe("90s");
  });

  it("lists active loops with next-fire countdown", () => {
    const text = formatLoopList([loop({ id: 2, nextFireAt: 61_000, fires: 3 })], 1000);
    expect(text).toContain("#2 every 5m");
    expect(text).toContain("fired 3x");
    expect(text).toContain("next in 60s");
    expect(formatLoopList([], 0)).toContain("No active loops");
  });
});
