import { Box, Text } from "ink";

/**
 * Retro terminal pixel-art wordmark: "BUBBLE CODE" rendered in a 5×7 block
 * font with a light-blue front face and a dark-blue offset shadow (extrusion),
 * plus a pale highlight along the top edge. Purely decorative; keeps the
 * terminal background.
 */

const LETTER_W = 5;
const LETTER_H = 7;
const LETTER_GAP = 2;
const WORD_GAP = 4;
const SHADOW_DX = 1;
const SHADOW_DY = 1;

const FRONT = "#E0E6ED";
const SHADOW = "#3A4A5A";
const HIGHLIGHT = "#FFFFFF";

// 5×7 bold block pixel font ("1" = filled, "0" = empty).
const FONT: Record<string, string[]> = {
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

const WORD = "BUBBLE CODE";

export interface WordmarkCell {
  char: string;
  color: string | null;
}

function letterOffsets(): Array<{ ch: string; x: number }> {
  const offsets: Array<{ ch: string; x: number }> = [];
  let x = 0;
  for (const ch of WORD) {
    offsets.push({ ch, x });
    x += ch === " " ? WORD_GAP : LETTER_W + LETTER_GAP;
  }
  return offsets;
}

export function buildBubbleCodeGrid(): WordmarkCell[][] {
  const offsets = letterOffsets();
  const last = offsets[offsets.length - 1];
  const width = last.x + LETTER_W + SHADOW_DX;
  const height = LETTER_H + SHADOW_DY;

  const grid: WordmarkCell[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: " ", color: null })),
  );

  const set = (x: number, y: number, color: string) => {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      grid[y][x] = { char: "█", color };
    }
  };

  const forEachPixel = (cb: (x: number, y: number) => void) => {
    for (const { ch, x } of offsets) {
      const glyph = FONT[ch] ?? FONT[" "];
      for (let r = 0; r < LETTER_H; r++) {
        for (let c = 0; c < LETTER_W; c++) {
          if (glyph[r][c] === "1") cb(x + c, r);
        }
      }
    }
  };

  // Extrusion (dark blue), offset one cell right + one down.
  forEachPixel((x, y) => set(x + SHADOW_DX, y + SHADOW_DY, SHADOW));

  // Front face (light blue).
  forEachPixel((x, y) => set(x, y, FRONT));

  // Top-edge highlight (pale blue) for a bit of shine.
  for (const { ch, x } of offsets) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let c = 0; c < LETTER_W; c++) {
      if (glyph[0][c] === "1") set(x + c, 0, HIGHLIGHT);
    }
  }

  return grid;
}

function mergeRow(row: WordmarkCell[]): Array<{ text: string; color: string | null }> {
  const segments: Array<{ text: string; color: string | null }> = [];
  let current: { text: string; color: string | null } | null = null;
  for (const cell of row) {
    if (current && current.color === cell.color) {
      current.text += cell.char;
    } else {
      current = { text: cell.char, color: cell.color };
      segments.push(current);
    }
  }
  // Drop trailing empty cells so the wordmark has no trailing whitespace.
  while (segments.length > 0 && segments[segments.length - 1].color === null) {
    segments.pop();
  }
  return segments;
}

export function BubbleCodeWordmark({ width }: { width?: number }) {
  const grid = buildBubbleCodeGrid();
  const contentWidth = grid[0]?.length ?? 0;
  const leftPad = width && width > contentWidth
    ? Math.floor((width - contentWidth) / 2)
    : 0;
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={leftPad}>
      {grid.map((row, rowIndex) => {
        const segments = mergeRow(row);
        return (
          <Box key={rowIndex} flexDirection="row" flexShrink={0}>
            {segments.map((segment, segmentIndex) => (
              <Text key={segmentIndex} color={segment.color ?? undefined}>
                {segment.text}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
