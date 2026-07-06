import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../agent/budget-ledger.js";

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

  it("keeps per-source tallies for usage attribution", () => {
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
