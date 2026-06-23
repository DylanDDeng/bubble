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
  const headline = base ? `${labels.join(" ")} ${base}` : labels.join(" ");
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
