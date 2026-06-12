import { describe, expect, it } from "vitest";
import {
  BudgetLedger,
  childHardCap,
  CHILD_HARD_CAP_FLOOR,
  computeChildTokenCap,
  DEFAULT_CHILD_TOKEN_CAP,
} from "../agent/budget-ledger.js";

describe("BudgetLedger", () => {
  it("records child usage as part of the shared total without per-child caps", () => {
    const ledger = new BudgetLedger(100);

    ledger.recordUsage({ promptTokens: 6, completionTokens: 3 }, { runId: "run-1", subAgentId: "child-1" });
    expect(ledger.signal.aborted).toBe(false);
    expect(ledger.snapshot().spent).toBe(9);

    ledger.recordUsage({ promptTokens: 1, completionTokens: 0 }, { runId: "run-1", subAgentId: "child-1" });
    expect(ledger.signal.aborted).toBe(false);
    expect(ledger.snapshot().spent).toBe(10);
  });

  it("aborts the parent signal when the shared total budget is exhausted", () => {
    const ledger = new BudgetLedger(5);

    ledger.recordUsage({ promptTokens: 4, completionTokens: 2 }, { runId: "run-1" });

    expect(ledger.signal.aborted).toBe(true);
  });

  it("keeps per-source tallies so child caps can be enforced", () => {
    const ledger = new BudgetLedger();
    ledger.recordUsage({ promptTokens: 6, completionTokens: 3 }, { runId: "r", subAgentId: "child-1" });
    ledger.recordUsage({ promptTokens: 2, completionTokens: 1 }, { runId: "r", subAgentId: "child-2" });
    ledger.recordUsage({ promptTokens: 5, completionTokens: 0 }, { runId: "r" });

    expect(ledger.spentBy("child-1")).toBe(9);
    expect(ledger.spentBy("child-2")).toBe(3);
    expect(ledger.spentBy()).toBe(5);
    expect(ledger.remaining()).toBeUndefined();
  });
});

describe("computeChildTokenCap", () => {
  it("uses the absolute default on limit-free hosts (the cap is effective by default)", () => {
    const ledger = new BudgetLedger();
    const cap = computeChildTokenCap({ ledger, subAgentId: "c", activeChildren: 3 });
    expect(cap.soft).toBe(DEFAULT_CHILD_TOKEN_CAP);
    expect(cap.hard).toBe(DEFAULT_CHILD_TOKEN_CAP + CHILD_HARD_CAP_FLOOR);
  });

  it("bounds the cap by the fair share of a limited pool after the parent reserve", () => {
    const ledger = new BudgetLedger(100_000);
    // reserve = 20k; available = 80k; share for (active 3 + 1) = 20k
    const cap = computeChildTokenCap({ ledger, subAgentId: "c", activeChildren: 3 });
    expect(cap.soft).toBe(20_000);
  });

  it("lets a profile only lower the cap, and config override applies", () => {
    const lowered = computeChildTokenCap({ subAgentId: "c", activeChildren: 0, profileMaxTokens: 50_000 });
    expect(lowered.soft).toBe(50_000);
    const config = computeChildTokenCap({ subAgentId: "c", activeChildren: 0, configCap: 10_000, profileMaxTokens: 50_000 });
    expect(config.soft).toBe(10_000);
  });
});

describe("childHardCap", () => {
  it("keeps at least the absolute floor above soft, growing with average turn size", () => {
    expect(childHardCap(1_000, 100)).toBe(1_000 + CHILD_HARD_CAP_FLOOR);
    expect(childHardCap(1_000, 50_000)).toBe(101_000);
  });
});
