import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { useTheme } from "./theme.js";
import type { DisplayMessage } from "./display-history.js";

interface WelcomeBannerProps {
  terminalColumns: number;
  tips: string[];
  /** One-line "update available" notice shown under the version. */
  updateNotice?: string;
  /** Friendly working directory (~ collapsed). */
  cwd?: string;
  providerId?: string;
  modelLabel?: string;
  /** Active thinking level, rendered as part of the model unit (e.g. "xhigh"). */
  thinkingLabel?: string;
}

interface WelcomeVisibilityInput {
  messages: Pick<DisplayMessage, "role" | "syntheticKind">[];
  startedWithVisibleHistory: boolean;
}

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();
const COMPACT_LOGO = [
  " ▄  ▄ ",
  "██████",
  "█ ██ █",
  "██████",
  " ▀  ▀ ",
];

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
  tips,
  updateNotice,
  cwd,
  providerId,
  modelLabel,
  thinkingLabel,
}: WelcomeBannerProps) {
  const theme = useTheme();
  const effectiveWidth = Math.max(24, Math.min(terminalColumns - 2, 96));
  const modelLine = formatModelLine({
    providerId,
    modelLabel,
    thinkingLabel,
    tips,
  });

  return (
    <Box width={effectiveWidth} flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2} flexShrink={0}>
          {COMPACT_LOGO.map((line, rowIndex) => (
            <Text key={`logo-row-${rowIndex}`} color={theme.warning} bold>
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Box>
            <Text bold color={theme.inputText}>Bubble</Text>
            <Text color={theme.muted}> {PACKAGE_VERSION}</Text>
          </Box>
          {modelLine && (
            <Text color={theme.muted}>
              {modelLine}
            </Text>
          )}
          {cwd && (
            <Text color={theme.muted}>
              {cwd}
            </Text>
          )}
        </Box>
      </Box>
      {updateNotice && (
        <Box>
          <Text color={theme.accent}>{updateNotice}</Text>
        </Box>
      )}
    </Box>
  );
}

export function formatModelLine({
  providerId,
  modelLabel,
  thinkingLabel,
  tips,
}: Pick<WelcomeBannerProps, "providerId" | "modelLabel" | "thinkingLabel" | "tips">): string {
  const parts: string[] = [];
  // MiniMax thinking is a binary toggle (adaptive thinking), so label it
  // "thinking mode" rather than "<level> effort"; and its provider id
  // ("minimax-anthropic") is redundant with the model name, so omit it.
  const isMiniMax = (providerId || "").toLowerCase().includes("minimax");
  if (modelLabel) {
    if (thinkingLabel && isMiniMax) parts.push(modelLabel, "thinking mode");
    else if (thinkingLabel) parts.push(`${modelLabel} with ${thinkingLabel} effort`);
    else parts.push(modelLabel);
  }
  const readyTip = tips.find((item) => item.startsWith("Ready with"));
  if (!modelLabel && readyTip) parts.push(readyTip.replace(/^Ready with\s+/, ""));
  if (providerId && !isMiniMax) parts.push(providerId);
  return parts.join(" · ");
}

function readPackageVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}
