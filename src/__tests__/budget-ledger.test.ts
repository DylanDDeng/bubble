import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../agent/budget-ledger.js";

describe("BudgetLedger", () => {
  it("is pure accounting: recording usage never aborts anything", () => {
    const ledger = new BudgetLedger();

    ledger.recordUsage({ promptTokens: 600_000, completionTokens: 400_000 }, { runId: "run-1", subAgentId: "child-1" });

    expect(ledger.totalSpent()).toBe(1_000_000);
    expect((ledger as any).signal).toBeUndefined();
  });

  it("keeps per-source tallies for usage attribution", () => {
    const ledger = new BudgetLedger();
    ledger.recordUsage({ promptTokens: 6, completionTokens: 3 }, { runId: "r", subAgentId: "child-1" });
    ledger.recordUsage({ promptTokens: 2, completionTokens: 1 }, { runId: "r", subAgentId: "child-2" });
    ledger.recordUsage({ promptTokens: 5, completionTokens: 0 }, { runId: "r" });

    expect(ledger.spentBy("child-1")).toBe(9);
    expect(ledger.spentBy("child-2")).toBe(3);
    expect(ledger.spentBy()).toBe(5);
    expect(ledger.totalSpent()).toBe(17);
  });
});
