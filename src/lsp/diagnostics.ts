import { relative } from "node:path";

export interface LspDiagnostic {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface FormatDiagnosticsOptions {
  max?: number;
  includeSummary?: boolean;
}

const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const SEVERITY_RANK: Record<number, number> = {
  1: 0,
  2: 1,
  3: 2,
  4: 3,
};

export function formatDiagnostics(
  filePath: string,
  diagnostics: LspDiagnostic[],
  cwd?: string,
  options: FormatDiagnosticsOptions = {},
): string {
  const normalized = normalizeDiagnostics(diagnostics);
  if (!normalized.length) return "";
  const label = cwd ? relative(cwd, filePath) || "." : filePath;
  const limit = options.max ?? 20;
  const lines = normalized.slice(0, limit).map((diagnostic) => {
    const line = (diagnostic.range?.start?.line ?? 0) + 1;
    const character = (diagnostic.range?.start?.character ?? 0) + 1;
    const severity = SEVERITY_LABELS[diagnostic.severity ?? 1] ?? "diagnostic";
    const source = diagnostic.source ? ` ${diagnostic.source}` : "";
    const code = diagnostic.code === undefined ? "" : ` [${diagnostic.code}]`;
    return `- ${label}:${line}:${character} ${severity}${source}${code}: ${diagnostic.message}`;
  });
  if (normalized.length > lines.length) {
    lines.push(`- ... ${normalized.length - lines.length} more diagnostic(s)`);
  }
  if (options.includeSummary) {
    lines.unshift(formatDiagnosticSummary(normalized));
  }
  return lines.join("\n");
}

export function formatDiagnosticBlocks(
  cwd: string,
  currentFile: string,
  diagnostics: Record<string, LspDiagnostic[]>,
): string {
  let output = "";
  let otherFiles = 0;
  for (const [file, issues] of sortDiagnosticEntries(diagnostics, currentFile)) {
    const normalized = normalizeDiagnostics(issues);
    if (!normalized.length) continue;
    if (file === currentFile) {
      output += `\n\nLSP diagnostics in this file:\n${formatDiagnostics(file, normalized, cwd, { includeSummary: true })}`;
      continue;
    }
    if (otherFiles >= 5) continue;
    otherFiles += 1;
    output += `\n\nLSP diagnostics in other files:\n${formatDiagnostics(file, normalized, cwd, { includeSummary: true })}`;
  }
  return output;
}

export function normalizeDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
  const byKey = new Map<string, LspDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.range?.start?.line ?? 0,
      diagnostic.range?.start?.character ?? 0,
      diagnostic.severity ?? 1,
      diagnostic.source ?? "",
      diagnostic.code ?? "",
      diagnostic.message,
    ].join("|");
    if (!byKey.has(key)) byKey.set(key, diagnostic);
  }
  return [...byKey.values()].sort(compareDiagnostic);
}

export function formatDiagnosticSummary(diagnostics: LspDiagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const diagnostic of diagnostics) {
    const label = SEVERITY_LABELS[diagnostic.severity ?? 1] ?? "error";
    if (label in counts) counts[label as keyof typeof counts] += 1;
  }
  const parts = [
    counts.error ? `${counts.error} error${counts.error === 1 ? "" : "s"}` : "",
    counts.warning ? `${counts.warning} warning${counts.warning === 1 ? "" : "s"}` : "",
    counts.info ? `${counts.info} info` : "",
    counts.hint ? `${counts.hint} hint${counts.hint === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? `Summary: ${parts.join(", ")}` : "Summary: no diagnostics";
}

function sortDiagnosticEntries(
  diagnostics: Record<string, LspDiagnostic[]>,
  currentFile: string,
): Array<[string, LspDiagnostic[]]> {
  return Object.entries(diagnostics).sort(([fileA, issuesA], [fileB, issuesB]) => {
    if (fileA === currentFile && fileB !== currentFile) return -1;
    if (fileB === currentFile && fileA !== currentFile) return 1;
    return strongestSeverity(issuesA) - strongestSeverity(issuesB) || fileA.localeCompare(fileB);
  });
}

function strongestSeverity(diagnostics: LspDiagnostic[]): number {
  return Math.min(...diagnostics.map((diagnostic) => SEVERITY_RANK[diagnostic.severity ?? 1] ?? 99), 99);
}

function compareDiagnostic(a: LspDiagnostic, b: LspDiagnostic): number {
  return (SEVERITY_RANK[a.severity ?? 1] ?? 99) - (SEVERITY_RANK[b.severity ?? 1] ?? 99)
    || (a.range?.start?.line ?? 0) - (b.range?.start?.line ?? 0)
    || (a.range?.start?.character ?? 0) - (b.range?.start?.character ?? 0)
    || (a.source ?? "").localeCompare(b.source ?? "")
    || a.message.localeCompare(b.message);
}
