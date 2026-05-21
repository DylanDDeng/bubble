import React from "react";
import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { useTheme, type Theme } from "./theme.js";
import type { DisplayMessage } from "./display-history.js";

interface WelcomeBannerProps {
  terminalColumns: number;
  modelLabel?: string;
  cwd?: string;
  tips: string[];
  skillsCount?: number;
  mcpConnectedCount?: number;
  mcpTotalCount?: number;
  hasAgentsFile?: boolean;
}

interface WelcomeVisibilityInput {
  messages: Pick<DisplayMessage, "role" | "syntheticKind">[];
  startedWithVisibleHistory: boolean;
}

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();

const BUBBLE_LOGO_LETTERS = [
  [
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
  ],
  [
    "██   ██",
    "██   ██",
    "██   ██",
    "██   ██",
    "██   ██",
    "██   ██",
    " █████ ",
  ],
  [
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
  ],
  [
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
    "██   ██",
    "██   ██",
    "██████ ",
  ],
  [
    "██     ",
    "██     ",
    "██     ",
    "██     ",
    "██     ",
    "██     ",
    "███████",
  ],
  [
    "███████",
    "██     ",
    "██     ",
    "██████ ",
    "██     ",
    "██     ",
    "███████",
  ],
];

/**
 * Derive a 6-step logo gradient from the active theme tokens so the banner
 * stays readable on both dark and light backgrounds.
 */
function logoColors(theme: Theme): string[] {
  return [
    theme.userMessageText,
    theme.userMessageText,
    theme.inputBorder,
    theme.inputBorder,
    theme.traceCommand,
    theme.traceCommand,
  ];
}
const COMPACT_LOGO = ["B", "U", "B", "B", "L", "E"];
const WIDE_LOGO_MIN_WIDTH = 52;

export function shouldShowWelcomeBanner({
  startedWithVisibleHistory,
}: WelcomeVisibilityInput): boolean {
  // Keep banner visibility tied to the initial history, not transient overlays,
  // so opening and closing a picker does not move it in the transcript.
  if (startedWithVisibleHistory) return false;
  return true;
}

export function WelcomeBanner({
  terminalColumns,
  modelLabel,
  cwd,
  tips,
  skillsCount = 0,
  mcpConnectedCount = 0,
  mcpTotalCount = 0,
  hasAgentsFile = false,
}: WelcomeBannerProps) {
  const theme = useTheme();
  const effectiveWidth = Math.max(20, Math.min(terminalColumns - 2, 118));
  const useWideLogo = effectiveWidth >= WIDE_LOGO_MIN_WIDTH;
  const actionableTips = tips
    .filter((item) => !item.startsWith("Ready with") && item.trim().length > 0)
    .slice(0, 2);
  const tip = actionableTips.length > 0
    ? actionableTips.join(" · ")
    : "Type / for commands and @ to reference files";
  const modelLine = modelLabel ? `${modelLabel}${cwd ? ` · ${cwd}` : ""}` : cwd;

  return (
    <Box width={effectiveWidth} flexDirection="column" alignItems="center" marginBottom={1}>
      <Box flexDirection="column" alignItems="center">
        {useWideLogo
          ? BUBBLE_LOGO_LETTERS[0]!.map((_, rowIndex) => (
            <LogoRow key={`logo-row-${rowIndex}`} rowIndex={rowIndex} />
          ))
          : <CompactLogo />}
      </Box>
      <Box marginTop={2}>
        <Text bold color={theme.muted}>{PACKAGE_VERSION}</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={theme.userMessageText}>TIP: </Text>
        <Text bold color={theme.userMessageText}>{tip}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>shift+tab to cycle modes · ctrl+r for reasoning · ctrl+o for trace</Text>
      </Box>
      {modelLine && (
        <Box>
          <Text color={theme.muted}>{truncateToWidth(modelLine, effectiveWidth - 4)}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <StatusItem label="Skills" count={skillsCount} ok={skillsCount > 0} />
        <Text color={theme.muted}>  </Text>
        <StatusItem label="MCPs" count={mcpConnectedCount} total={mcpTotalCount} ok={mcpTotalCount === 0 || mcpConnectedCount === mcpTotalCount} />
        <Text color={theme.muted}>  </Text>
        <StatusItem label="AGENTS.md" ok={hasAgentsFile} />
      </Box>
    </Box>
  );
}

function LogoRow({ rowIndex }: { rowIndex: number }) {
  const theme = useTheme();
  const colors = logoColors(theme);
  return (
    <Box>
      {BUBBLE_LOGO_LETTERS.map((letter, index) => (
        <React.Fragment key={`${index}-${rowIndex}`}>
          <Text bold color={colors[index]}>
            {letter[rowIndex]}
          </Text>
          {index < BUBBLE_LOGO_LETTERS.length - 1 && <Text> </Text>}
        </React.Fragment>
      ))}
    </Box>
  );
}

function CompactLogo() {
  const theme = useTheme();
  const colors = logoColors(theme);
  return (
    <Box>
      {COMPACT_LOGO.map((letter, index) => (
        <Text key={`${letter}-${index}`} bold color={colors[index]}>
          {letter}
        </Text>
      ))}
    </Box>
  );
}

function StatusItem({
  label,
  count,
  total,
  ok,
}: {
  label: string;
  count?: number;
  total?: number;
  ok: boolean;
}) {
  const theme = useTheme();
  const countText = count === undefined
    ? ""
    : total !== undefined && total > count
      ? ` (${count}/${total})`
      : ` (${count})`;
  return (
    <>
      <Text bold color={theme.muted}>{label}{countText} </Text>
      <Text bold color={ok ? theme.success : theme.error}>{ok ? "✓" : "×"}</Text>
    </>
  );
}

function readPackageVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(1, maxWidth - 1)) + "…";
}
