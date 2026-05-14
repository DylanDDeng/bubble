import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";
import type { RecentSession } from "./recent-activity.js";
import { formatRelativeTime, truncatePreview } from "./recent-activity.js";

interface WelcomeBannerProps {
  terminalColumns: number;
  greeting?: string;
  modelLabel?: string;
  cwd?: string;
  tips: string[];
  recentSessions: RecentSession[];
}

const ORANGE = "#D97A4A";
const PINK = "#F5B8C8";
const EYE = "#7FB069";
const DARK = "#4A2F1A";
const CREAM = "#F5EAD6";
const O = ORANGE;
const P = PINK;
const E = EYE;
const D = DARK;
const W = CREAM;
const _: null = null;

// 12 cols × 12 rows. Renders 12 chars wide × 6 rows tall using half-block technique.
const CAT: (string | null)[][] = [
  [O, O, _, _, _, _, _, _, _, _, O, O],
  [O, P, O, _, _, _, _, _, _, O, P, O],
  [O, P, P, O, O, O, O, O, O, P, P, O],
  [O, O, O, O, O, O, O, O, O, O, O, O],
  [O, O, E, E, O, O, O, O, E, E, O, O],
  [O, O, E, E, O, O, O, O, E, E, O, O],
  [O, O, O, O, O, D, D, O, O, O, O, O],
  [O, O, O, O, O, P, P, O, O, O, O, O],
  [_, O, O, W, W, W, W, W, W, O, O, _],
  [_, O, W, W, W, W, W, W, W, W, O, _],
  [_, _, O, W, W, W, W, W, W, O, _, _],
  [_, _, _, O, O, O, O, O, O, _, _, _],
];

const MIN_TWO_COLUMN_WIDTH = 80;
const MAX_BANNER_WIDTH = 88;

function Sprite({ pixels }: { pixels: (string | null)[][] }) {
  const rows: React.ReactElement[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const top = pixels[y];
    const bot = pixels[y + 1] ?? [];
    const cells: React.ReactElement[] = [];
    for (let x = 0; x < top.length; x++) {
      const t = top[x];
      const b = bot[x] ?? null;
      if (t === null && b === null) {
        cells.push(<Text key={x}> </Text>);
      } else if (t === null) {
        cells.push(<Text key={x} color={b!}>▄</Text>);
      } else if (b === null) {
        cells.push(<Text key={x} color={t}>▀</Text>);
      } else {
        cells.push(<Text key={x} color={t} backgroundColor={b}>▀</Text>);
      }
    }
    rows.push(<Box key={y}>{cells}</Box>);
  }
  return <>{rows}</>;
}

export function WelcomeBanner({
  terminalColumns,
  greeting = "Welcome to Bubble",
  modelLabel,
  cwd,
  tips,
  recentSessions,
}: WelcomeBannerProps) {
  const twoColumn = terminalColumns >= MIN_TWO_COLUMN_WIDTH;
  const effectiveWidth = Math.min(terminalColumns, MAX_BANNER_WIDTH);
  const rightColWidth = twoColumn ? Math.min(40, Math.max(28, Math.floor(effectiveWidth * 0.4))) : 0;

  const leftColumn = (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Box alignSelf="center">
        <Text bold color={theme.userMessageText}>{greeting}</Text>
      </Box>
      <Box alignSelf="center">
        <Box flexDirection="column">
          <Sprite pixels={CAT} />
        </Box>
      </Box>
      {modelLabel && (
        <Box alignSelf="center">
          <Text color={theme.muted}>{modelLabel}</Text>
        </Box>
      )}
      {cwd && (
        <Box alignSelf="center">
          <Text dimColor>{cwd}</Text>
        </Box>
      )}
    </Box>
  );

  const rightColumn = (
    <Box flexDirection="column" width={rightColWidth} paddingX={2}>
      <Text bold color={theme.accent}>Tips for getting started</Text>
      {tips.map((tip, idx) => (
        <Text key={idx}>{truncateToWidth(tip, rightColWidth - 4)}</Text>
      ))}
      <Box marginTop={1}>
        <Text bold color={theme.accent}>Recent activity</Text>
      </Box>
      {recentSessions.length === 0 ? (
        <Text dimColor>No recent activity</Text>
      ) : (
        recentSessions.map((s) => (
          <Box key={s.file} flexDirection="column">
            <Text color={theme.muted}>{formatRelativeTime(s.modifiedAt)}</Text>
            <Text>{truncatePreview(s.preview, rightColWidth - 4)}</Text>
          </Box>
        ))
      )}
    </Box>
  );

  if (!twoColumn) {
    return (
      <Box
        width={effectiveWidth}
        flexDirection="column"
        borderStyle="bold"
        borderColor={theme.border}
        paddingY={1}
      >
        {leftColumn}
        <Box marginTop={1} paddingX={2}>
          <Box flexDirection="column">
            <Text bold color={theme.accent}>Tips</Text>
            {tips.map((tip, idx) => (
              <Text key={idx}>{truncateToWidth(tip, terminalColumns - 6)}</Text>
            ))}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      width={effectiveWidth}
      borderStyle="bold"
      borderColor={theme.border}
      paddingY={1}
      flexDirection="row"
    >
      {leftColumn}
      <Box width={1} flexDirection="column">
        {Array.from({ length: 10 }).map((_unused, i) => (
          <Text key={i} color={theme.border}>│</Text>
        ))}
      </Box>
      {rightColumn}
    </Box>
  );
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(1, maxWidth - 1)) + "…";
}
