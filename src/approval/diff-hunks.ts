/**
 * Parses unified-diff output (e.g. from `diff`'s `createTwoFilesPatch`) into
 * discrete hunks so the TUI can render each one with its own header and fold
 * gracefully when the total body exceeds the available line budget.
 */

export interface DiffHunk {
  /** The `@@ -old,count +new,count @@ ...` line verbatim. */
  header: string;
  /** Body lines, each beginning with '+', '-', or ' '. No trailing newline. */
  lines: string[];
}

export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const rawLines = diff.split("\n");
  let current: DiffHunk | null = null;

  for (const line of rawLines) {
    if (
      line.startsWith("===") ||
      line.startsWith("Index:") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = { header: line, lines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\ No newline")) continue;
    current.lines.push(line);
  }

  if (current) hunks.push(current);
  return hunks;
}
