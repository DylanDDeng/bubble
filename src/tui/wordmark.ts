export type BubbleWordmarkTone = "ink" | "stone" | "soft" | "caption";

export interface BubbleWordmarkSegment {
  text: string;
  tone: BubbleWordmarkTone;
}

export interface BubbleWordmarkLine {
  text?: string;
  tone?: BubbleWordmarkTone;
  segments?: BubbleWordmarkSegment[];
}

export const BUBBLE_WORDMARK: BubbleWordmarkLine[] = [
  { segments: [{ text: "████   █   █  ████  ", tone: "stone" }, { text: " ████   █      █████", tone: "ink" }] },
  { segments: [{ text: "█   █  █   █  █   █ ", tone: "stone" }, { text: " █   █  █      █    ", tone: "ink" }] },
  { segments: [{ text: "████   █   █  ████  ", tone: "stone" }, { text: " ████   █      ████ ", tone: "ink" }] },
  { segments: [{ text: "█   █  █   █  █   █ ", tone: "stone" }, { text: " █   █  █      █    ", tone: "ink" }] },
  { segments: [{ text: "████    ███   ████  ", tone: "stone" }, { text: " ████   █████  █████", tone: "ink" }] },
];

export const BUBBLE_COMPACT_WORDMARK: BubbleWordmarkLine[] = [
  { segments: [{ text: "bub", tone: "stone" }, { text: "ble", tone: "ink" }] },
];

export function bubbleWordmarkLineText(line: BubbleWordmarkLine) {
  if (line.segments) return line.segments.map((segment) => segment.text).join("");
  return line.text ?? "";
}

export function bubbleWordmarkMaxWidth(lines = BUBBLE_WORDMARK) {
  return Math.max(...lines.map((line) => bubbleWordmarkLineText(line).length));
}

export function bubbleWordmarkForWidth(width: number) {
  return width < bubbleWordmarkMaxWidth() + 4 ? BUBBLE_COMPACT_WORDMARK : BUBBLE_WORDMARK;
}
