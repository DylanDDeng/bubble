/** @jsxImportSource @opentui/react */
import React from "react";
import { useTheme } from "../theme.js";
import { parseDiffHunks, type DiffHunk } from "../../approval/diff-hunks.js";

interface DiffViewProps {
  diff: string;
  /** Hard cap on total rendered lines across all hunks. Excess is truncated. */
  maxLines?: number;
}

const DEFAULT_MAX_LINES = 40;

export function DiffView({ diff, maxLines = DEFAULT_MAX_LINES }: DiffViewProps) {
  const theme = useTheme();
  const hunks = parseDiffHunks(diff);
  if (hunks.length === 0) {
    return (
      <text fg={theme.muted} content="(no diff body to display)" />
    );
  }

  // Distribute the line budget across hunks. Simple approach: render hunks in
  // order until the budget is exhausted; if a hunk overflows, keep its header,
  // show as many body lines as fit, then emit a "… N more" marker.
  let remaining = maxLines;
  const rendered: Array<{ hunk: DiffHunk; shown: string[]; truncatedBy: number }> = [];
  let trailingSkipped = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    if (remaining <= 1) {
      trailingSkipped += hunk.lines.length + 1;
      continue;
    }
    remaining -= 1; // header line
    const available = Math.max(0, remaining);
    if (hunk.lines.length <= available) {
      rendered.push({ hunk, shown: hunk.lines, truncatedBy: 0 });
      remaining -= hunk.lines.length;
    } else {
      const shown = hunk.lines.slice(0, available);
      rendered.push({ hunk, shown, truncatedBy: hunk.lines.length - available });
      remaining = 0;
    }
  }

  return (
    <box style={{ flexDirection: "column" }}>
      {rendered.map(({ hunk, shown, truncatedBy }, i) => (
        <box key={i} style={{ flexDirection: "column" }}>
          <text fg={theme.accent}>{hunk.header}</text>
          {shown.map((line, j) => (
            <text key={j} fg={colorForDiffLine(line)}>
              {line || " "}
            </text>
          ))}
          {truncatedBy > 0 && (
            <text fg={theme.muted}>{`… ${truncatedBy} more line${truncatedBy === 1 ? "" : "s"} in this hunk`}</text>
          )}
        </box>
      ))}
      {trailingSkipped > 0 && (
        <text fg={theme.muted}>{`… ${trailingSkipped} more line${trailingSkipped === 1 ? "" : "s"} across later hunks`}</text>
      )}
    </box>
  );
}

function colorForDiffLine(line: string): string | undefined {
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined;
}