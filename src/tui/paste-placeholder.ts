export const LONG_PASTE_CHAR_THRESHOLD = 1000;
export const LONG_PASTE_LINE_THRESHOLD = 20;

export interface PastedContentReference {
  marker: string;
  content: string;
}

export function countTextLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

export function shouldCollapsePastedContent(text: string): boolean {
  if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
  return countTextLines(text) >= LONG_PASTE_LINE_THRESHOLD;
}

export function createPastedContentMarker(content: string, index = 1): string {
  const safeIndex = Math.max(1, Math.floor(index));
  const lineCount = countTextLines(content);
  const size = lineCount > 1
    ? `${lineCount} ${lineCount === 1 ? "line" : "lines"}`
    : `${content.length} ${content.length === 1 ? "char" : "chars"}`;
  return `[Pasted text #${safeIndex} +${size}]`;
}

export function expandPastedContentMarkers(
  displayText: string,
  references: PastedContentReference[],
): string {
  if (references.length === 0 || displayText.length === 0) return displayText;

  let expanded = "";
  let index = 0;
  const used = new Set<number>();
  while (index < displayText.length) {
    let matched = -1;
    for (let i = 0; i < references.length; i++) {
      const ref = references[i]!;
      if (!used.has(i) && displayText.startsWith(ref.marker, index)) {
        matched = i;
        break;
      }
    }

    if (matched >= 0) {
      const ref = references[matched]!;
      expanded += ref.content;
      index += ref.marker.length;
      used.add(matched);
      continue;
    }

    expanded += displayText[index];
    index += 1;
  }
  return expanded;
}
