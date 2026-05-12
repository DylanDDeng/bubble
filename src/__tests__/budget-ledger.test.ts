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
});
