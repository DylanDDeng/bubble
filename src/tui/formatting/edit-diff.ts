import { countUnifiedDiffChanges } from "../../diff-stats.js";
import type { ToolResultMetadata } from "../../types.js";
import type { DisplayToolCall } from "../model/display-history.js";

export const EDIT_COLLAPSED_DIFF_LINES = 20;

export interface EditDiffDetails {
  diff: string;
  added: number;
  removed: number;
  path?: string;
}

export function getEditDiffDetails(tool: DisplayToolCall): EditDiffDetails | null {
  if (tool.name !== "edit" || tool.isError) return null;

  const metadata = tool.metadata;
  const metadataDiff = readMetadataString(metadata, "diff");
  const diff = metadataDiff ?? extractDiffFromResult(tool.result);
  if (!diff) return null;

  const counted = countUnifiedDiffChanges(diff);
  const added = readMetadataNumber(metadata, "addedLines") ?? counted.added;
  const removed = readMetadataNumber(metadata, "removedLines") ?? counted.removed;
  const path = readMetadataString(metadata, "path")
    ?? (typeof tool.args.path === "string" ? tool.args.path : undefined);

  return { diff, added, removed, path };
}

export function formatEditSuccessSummary(details: EditDiffDetails | null): string {
  const stats = details ? formatEditStats(details.added, details.removed) : "";
  return `Succeeded. File edited.${stats ? ` ${stats}` : ""}`;
}

export function formatEditStats(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} added`);
  if (removed > 0) parts.push(`-${removed} removed`);
  if (parts.length === 0) return "";
  return `(${parts.join(", ")})`;
}

function extractDiffFromResult(result: string | undefined): string | null {
  if (!result) return null;
  const normalized = result.replace(/\r\n/g, "\n");
  const marker = "\nDiff:\n";
  const index = normalized.indexOf(marker);
  if (index === -1) return null;

  const rawDiff = normalized.slice(index + marker.length);
  const diagnosticsIndex = rawDiff.search(/\n\nLSP diagnostics in /);
  const diff = diagnosticsIndex === -1 ? rawDiff : rawDiff.slice(0, diagnosticsIndex);
  return diff.trim().length > 0 ? diff : null;
}

function readMetadataString(metadata: ToolResultMetadata | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readMetadataNumber(metadata: ToolResultMetadata | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
