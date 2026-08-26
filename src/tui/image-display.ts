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
  // The composer text is the canonical presentation: if a chip was inserted
  // inline, keep it at that exact position after submit. Reconstructed legacy
  // messages do not contain labels, so only their missing chips fall back to
  // standalone reference rows.
  const missingLabels = labels.filter((label) => !input.includes(label));
  return [input, ...missingLabels.map(imageDisplayReferenceLine)].filter(Boolean).join("\n");
}

export function displayImagesFromPayload(payload: SubmitPayload): DisplayImageAttachment[] {
  const start = payload.imageDisplayStart ?? 1;
  return payload.images.map((attachment, index) => ({
    ...attachment,
    label: imageDisplayLabel(start + index),
  }));
}

export function imageAttachmentFromDataUrl(url: string): ImageAttachment | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url.trim());
  if (!match) return undefined;
  const mediaType = match[1]!.toLowerCase();
  const base64 = match[2]!.replace(/[\r\n]/g, "");
  if (!mediaType.startsWith("image/")) return undefined;
  let bytes = 0;
  try {
    bytes = Buffer.from(base64, "base64").byteLength;
  } catch {
    return undefined;
  }
  return { base64, mediaType, bytes, dataUrl: `data:${mediaType};base64,${base64}` };
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
import type { SubmitPayload } from "./model/composer-types.js";
import type { DisplayImageAttachment, ImageAttachment } from "./model/image-attachment.js";
