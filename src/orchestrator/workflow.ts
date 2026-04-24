import type { InvestigationCoverage } from "../agent/evidence-tracker.js";

export type WorkflowPhase = "investigate" | "correlate" | "conclude";

export function resolveWorkflowPhase(input: {
  coreCoverageComplete: boolean;
  searchFrozen: boolean;
}): WorkflowPhase {
  if (input.coreCoverageComplete) {
    return "conclude";
  }

  if (input.searchFrozen) {
    return "correlate";
  }

  return "investigate";
}

export function formatCoverageSummary(coverage: InvestigationCoverage): {
  covered: string[];
  pending: string[];
} {
  const items: Array<{ label: string; done: boolean }> = [
    { label: "config load paths", done: coverage.configLoadPaths },
    { label: "environment variable reads", done: coverage.envReads },
    { label: "persistence paths", done: coverage.persistencePaths },
    { label: "exposure paths", done: coverage.exposurePaths },
    { label: "masking or redaction signals", done: coverage.maskingSignals },
  ];

  return {
    covered: items.filter((item) => item.done).map((item) => item.label),
    pending: items.filter((item) => !item.done).map((item) => item.label),
  };
}
