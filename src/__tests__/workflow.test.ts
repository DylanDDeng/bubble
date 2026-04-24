import { describe, expect, it } from "vitest";
import { EvidenceTracker } from "../agent/evidence-tracker.js";
import { formatCoverageSummary, resolveWorkflowPhase } from "../orchestrator/workflow.js";

describe("security workflow helpers", () => {
  it("stays in investigate until coverage or freezing changes the phase", () => {
    expect(resolveWorkflowPhase({
      coreCoverageComplete: false,
      searchFrozen: false,
    })).toBe("investigate");

    expect(resolveWorkflowPhase({
      coreCoverageComplete: false,
      searchFrozen: true,
    })).toBe("correlate");

    expect(resolveWorkflowPhase({
      coreCoverageComplete: true,
      searchFrozen: false,
    })).toBe("conclude");
  });

  it("tracks security investigation evidence coverage", () => {
    const tracker = new EvidenceTracker();
    tracker.observe(
      { name: "read", parsedArgs: { path: "src/config.ts" } },
      { content: "const path = process.env.API_KEY_PATH\nwriteFileSync('auth.json', key)\nconsole.log(maskKey(key))" },
    );

    const summary = formatCoverageSummary(tracker.snapshot());
    expect(summary.covered).toContain("config load paths");
    expect(summary.covered).toContain("environment variable reads");
    expect(summary.covered).toContain("persistence paths");
    expect(summary.covered).toContain("exposure paths");
    expect(summary.covered).toContain("masking or redaction signals");
    expect(summary.pending).toEqual([]);
  });
});
