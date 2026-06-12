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

// Pixel cat mascot, drawn on the same half-block pixel grid as the letters:
// pointy ears, 2x2-pixel eyes, tiny mouth, round chin (10x14 pixels). It is
// stacked above the wordmark (icon-over-name lockup) rather than inlined, so
// its solid fill doesn't compete with the thin letter strokes.
const CAT_LINES: readonly string[] = [
  " █▄    ▄█ ",
  " ███▄▄███ ",
  "██████████",
  "█  ████  █",
  "████▀▀████",
  "██████████",
  " ▀██████▀ ",
];

export const BUBBLE_CAT: BubbleWordmarkLine[] = CAT_LINES.map((text) => ({
  text,
  tone: "brand",
}));

export const BUBBLE_CAT_LARGE: BubbleWordmarkLine[] = CAT_LINES.map((text) => ({
  text: text.split("").map((ch) => ch + ch).join(""),
  tone: "brand",
}));

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

const LOGO_GAP: BubbleWordmarkLine = { text: "", tone: "caption" };

// Icon-over-name lockup: pixel cat centered above the wordmark. Both render
// sites center every line independently, which is what stacks the cat over
// the text without any per-line padding here.
export function bubbleWordmarkForWidth(width: number) {
  if (width >= bubbleWordmarkMaxWidth(BUBBLE_WORDMARK_LARGE) + 4) {
    return [...BUBBLE_CAT_LARGE, LOGO_GAP, ...BUBBLE_WORDMARK_LARGE];
  }
  if (width >= bubbleWordmarkMaxWidth() + 4) {
    return [...BUBBLE_CAT, LOGO_GAP, ...BUBBLE_WORDMARK];
  }
  return BUBBLE_COMPACT_WORDMARK;
}
