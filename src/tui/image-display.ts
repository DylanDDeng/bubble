export interface ImageDisplayMessage {
  content?: string | null;
}

export function imageDisplayLabel(index: number): string {
  return `[Image #${index}]`;
}

export function imageDisplayLabels(count: number, labelStart = 1): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) =>
    imageDisplayLabel(labelStart + index),
  );
}

export function imageDisplayReferenceLine(label: string): string {
  return `└ ${label}`;
}

/**
 * Removes inline image labels (and a single trailing space) from composer text
 * before submit, so the labels stay a composer-only positioning affordance and
 * the model receives the user's actual text. Each label is removed once.
 */
export function stripInlineImageLabels(content: string, labels: string[]): string {
  let out = content;
  for (const label of labels) {
    const withSpace = out.indexOf(`${label} `);
    if (withSpace >= 0) {
      out = out.slice(0, withSpace) + out.slice(withSpace + label.length + 1);
      continue;
    }
    const bare = out.indexOf(label);
    if (bare >= 0) out = out.slice(0, bare) + out.slice(bare + label.length);
  }
  return out;
}

export function isImageDisplayReferenceLine(line: string): boolean {
  return /^└ \[Image #\d+\]$/.test(line.trimEnd());
}

export function splitImageDisplayContent(content: string): {
  bodyLines: string[];
  referenceLines: string[];
} {
  const bodyLines: string[] = [];
  const referenceLines: string[] = [];
  for (const line of content.split("\n")) {
    if (isImageDisplayReferenceLine(line)) {
      referenceLines.push(line);
    } else {
      bodyLines.push(line);
    }
  }
  return { bodyLines, referenceLines };
}

export function formatImageUserDisplayText(
  input: string,
  imageCount: number,
  labelStart = 1,
): string {
  if (imageCount <= 0) return input;
  const labels = imageDisplayLabels(imageCount, labelStart);
  const base = input.trim();
  // Labels already present inline (placed at their paste position in the
  // composer) stay where they are; only labels missing from the text are
  // prepended as a headline (back-compat for callers without inline labels).
  const missing = labels.filter((label) => !input.includes(label));
  const headline = missing.length > 0
    ? (base ? `${missing.join(" ")} ${base}` : missing.join(" "))
    : base;
  return [
    headline,
    ...labels.map(imageDisplayReferenceLine),
  ].join("\n");
}

export function nextImageDisplayLabelStart(messages: Iterable<ImageDisplayMessage>): number {
  let max = 0;
  const pattern = /\[Image #(\d+)\]/g;
  for (const message of messages) {
    const content = message.content ?? "";
    for (const match of content.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) max = Math.max(max, value);
    }
  }
  return max + 1;
}
