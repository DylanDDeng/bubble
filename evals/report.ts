import type { RunRecord } from "./types.js";

export interface ConfigSummary {
  configName: string;
  runs: number;
  passes: number;
  passRate: number;
  meanWallMs: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  totalCostUsd?: number;
  errors: number;
}

export function summarizeConfig(records: RunRecord[], configName: string): ConfigSummary {
  const rows = records.filter((record) => record.configName === configName);
  const passes = rows.filter((record) => record.pass).length;
  const costs = rows.map((record) => record.costUsd).filter((cost): cost is number => cost !== undefined);
  const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
  return {
    configName,
    runs: rows.length,
    passes,
    passRate: rows.length === 0 ? 0 : passes / rows.length,
    meanWallMs: mean(rows.map((record) => record.wallMs)),
    meanPromptTokens: mean(rows.map((record) => record.promptTokens)),
    meanCompletionTokens: mean(rows.map((record) => record.completionTokens)),
    totalCostUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined,
    errors: rows.filter((record) => record.error).length,
  };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const num = (value: number) => Math.round(value).toLocaleString("en-US");

/** Per-task pass matrix plus per-config aggregates; paired lift when comparing two configs. */
export function formatReport(records: RunRecord[], configNames: string[]): string {
  const lines: string[] = [];
  const taskIds = [...new Set(records.map((record) => record.taskId))];

  const header = ["task".padEnd(24), ...configNames.map((name) => name.padEnd(14))].join(" | ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const taskId of taskIds) {
    const cells = configNames.map((name) => {
      const rows = records.filter((record) => record.taskId === taskId && record.configName === name);
      if (rows.length === 0) return "-".padEnd(14);
      const marks = rows
        .map((record) => (record.error ? "E" : record.pass ? "✔" : "✘"))
        .join("");
      return marks.padEnd(14);
    });
    lines.push([taskId.padEnd(24), ...cells].join(" | "));
  }

  lines.push("");
  for (const name of configNames) {
    const summary = summarizeConfig(records, name);
    const cost = summary.totalCostUsd !== undefined ? ` · $${summary.totalCostUsd.toFixed(4)} total` : "";
    const errors = summary.errors > 0 ? ` · ${summary.errors} error(s)` : "";
    lines.push(
      `${name}: ${summary.passes}/${summary.runs} pass (${pct(summary.passRate)})`
      + ` · mean ${num(summary.meanWallMs)}ms`
      + ` · mean tokens ${num(summary.meanPromptTokens)} in / ${num(summary.meanCompletionTokens)} out`
      + cost + errors,
    );
  }

  if (configNames.length === 2) {
    const [baseline, candidate] = configNames.map((name) => summarizeConfig(records, name));
    const lift = (candidate.passRate - baseline.passRate) * 100;
    const sign = lift >= 0 ? "+" : "";
    lines.push("");
    lines.push(
      `lift (candidate - baseline): ${sign}${lift.toFixed(1)}pp pass rate`
      + ` · ${sign_(candidate.meanWallMs - baseline.meanWallMs)}ms wall`
      + ` · ${sign_(candidate.meanCompletionTokens - baseline.meanCompletionTokens)} output tokens`
      + (baseline.totalCostUsd !== undefined && candidate.totalCostUsd !== undefined
        ? ` · ${sign_(candidate.totalCostUsd - baseline.totalCostUsd, (v) => `$${v.toFixed(4)}`)} cost`
        : ""),
    );
    lines.push("Scores are observations, not gates — repeat runs before trusting small deltas.");
  }
  return lines.join("\n");
}

function sign_(value: number, format: (value: number) => string = (v) => num(v)): string {
  return `${value >= 0 ? "+" : "-"}${format(Math.abs(value))}`;
}
