export type BubbleWordmarkTone = "brand" | "ink" | "stone" | "soft" | "caption";

export interface BubbleWordmarkSegment {
  text: string;
  tone: BubbleWordmarkTone;
}

export interface BubbleWordmarkLine {
  text?: string;
  tone?: BubbleWordmarkTone;
  segments?: BubbleWordmarkSegment[];
}

interface BubbleWordmarkGlyph {
  tone: BubbleWordmarkTone;
  lines: string[];
}

// Pixel-style glyphs: each cell is a half-block "pixel" (█ ▀ ▄), giving the
// wordmark an 8-bit look while staying one terminal row per line.
const LEAD_B: BubbleWordmarkGlyph = {
  tone: "brand",
  lines: [
    "█   ",
    "█   ",
    "█▀█ ",
    "█ █ ",
    "█▄█ ",
    "    ",
  ],
};

const LOWER_B: BubbleWordmarkGlyph = {
  tone: "ink",
  lines: [
    "█   ",
    "█   ",
    "█▀█ ",
    "█ █ ",
    "█▄█ ",
    "    ",
  ],
};

const GLYPHS: Record<string, BubbleWordmarkGlyph> = {
  u: {
    tone: "ink",
    lines: [
      "    ",
      "    ",
      "█ █ ",
      "█ █ ",
      "█▄█ ",
      "    ",
    ],
  },
  l: {
    tone: "ink",
    lines: [
      "█  ",
      "█  ",
      "█  ",
      "█  ",
      "█▄ ",
      "   ",
    ],
  },
  e: {
    tone: "ink",
    lines: [
      "    ",
      "    ",
      "█▀█ ",
      "█▀▀ ",
      "█▄▄ ",
      "    ",
    ],
  },
  beta: {
    tone: "brand",
    lines: [
      "█▀▀▄ ",
      "█  █ ",
      "█▀▀▄ ",
      "█  █ ",
      "█▄▄▀ ",
      "█    ",
    ],
  },
  r: {
    tone: "ink",
    lines: [
      "    ",
      "    ",
      "█▀▀ ",
      "█   ",
      "█   ",
      "    ",
    ],
  },
  a: {
    tone: "ink",
    lines: [
      "    ",
      "    ",
      "▀▀█ ",
      "█▀█ ",
      "█▄█ ",
      "    ",
    ],
  },
  i: {
    tone: "ink",
    lines: [
      "  ",
      "▀ ",
      "█ ",
      "█ ",
      "█ ",
      "  ",
    ],
  },
  n: {
    tone: "ink",
    lines: [
      "    ",
      "    ",
      "█▀█ ",
      "█ █ ",
      "█ █ ",
      "    ",
    ],
  },
  space: {
    tone: "caption",
    lines: [
      "  ",
      "  ",
      "  ",
      "  ",
      "  ",
      "  ",
    ],
  },
};

const WORDMARK_GLYPHS: readonly BubbleWordmarkGlyph[] = [
  LEAD_B,
  GLYPHS.u,
  LOWER_B,
  LOWER_B,
  GLYPHS.l,
  GLYPHS.e,
  GLYPHS.space,
  GLYPHS.beta,
  GLYPHS.r,
  GLYPHS.a,
  GLYPHS.i,
  GLYPHS.n,
];

export const BUBBLE_WORDMARK: BubbleWordmarkLine[] = buildWordmark(WORDMARK_GLYPHS);

// Each pixel doubled horizontally: terminal cells are ~2:1 tall, so 2-char
// pixels render square and the wordmark reads much larger.
export const BUBBLE_WORDMARK_LARGE: BubbleWordmarkLine[] = buildWordmark(
  WORDMARK_GLYPHS.map((glyph) => ({
    tone: glyph.tone,
    lines: glyph.lines.map((line) => line.split("").map((ch) => ch + ch).join("")),
  })),
);

export const BUBBLE_COMPACT_WORDMARK: BubbleWordmarkLine[] = [
  {
    segments: [
      { text: "b", tone: "brand" },
      { text: "ubble ", tone: "ink" },
      { text: "β", tone: "brand" },
      { text: "rain", tone: "ink" },
    ],
  },
];

function buildWordmark(glyphs: readonly BubbleWordmarkGlyph[]): BubbleWordmarkLine[] {
  const rows = Math.max(...glyphs.map((glyph) => glyph.lines.length));
  const widths = glyphs.map((glyph) => Math.max(...glyph.lines.map((line) => line.length)));
  return Array.from({ length: rows }, (_, rowIndex) => ({
    segments: glyphs.map((glyph, glyphIndex) => ({
      text: (glyph.lines[rowIndex] ?? "").padEnd(widths[glyphIndex] ?? 0, " "),
      tone: glyph.tone,
    })),
  }));
}

export function bubbleWordmarkLineText(line: BubbleWordmarkLine) {
  if (line.segments) return line.segments.map((segment) => segment.text).join("");
  return line.text ?? "";
}

export function bubbleWordmarkMaxWidth(lines = BUBBLE_WORDMARK) {
  return Math.max(...lines.map((line) => bubbleWordmarkLineText(line).length));
}

export function bubbleWordmarkForWidth(width: number) {
  if (width >= bubbleWordmarkMaxWidth(BUBBLE_WORDMARK_LARGE) + 4) return BUBBLE_WORDMARK_LARGE;
  if (width >= bubbleWordmarkMaxWidth() + 4) return BUBBLE_WORDMARK;
  return BUBBLE_COMPACT_WORDMARK;
}
