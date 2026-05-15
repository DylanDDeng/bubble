export interface DiffChangeStats {
  added: number;
  removed: number;
}

export function countUnifiedDiffChanges(diff: string): DiffChangeStats {
  let added = 0;
  let removed = 0;

  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (isUnifiedDiffMetadataLine(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }

  return { added, removed };
}

function isUnifiedDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("@@") ||
    line.startsWith("Index:") ||
    line.startsWith("===") ||
    line.startsWith("\\ No newline")
  );
}
