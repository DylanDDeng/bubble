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
  /** Session identifier (session file basename). */
  sessionLabel?: string;
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

export function lerpColor(from: string, to: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  const out = pa.map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function GradientText({ text, from, to }: { text: string; from: string; to: string }) {
  const chars = [...text];
  return (
    <>
      {chars.map((ch, i) => (
        <Text
          key={`ch-${i}`}
          bold
          color={lerpColor(from, to, chars.length <= 1 ? 0 : i / (chars.length - 1))}
        >
          {ch}
        </Text>
      ))}
    </>
  );
}

export function WelcomeBanner({
  terminalColumns,
  tips,
  updateNotice,
  cwd,
  sessionLabel,
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
  const infoRows: Array<{ label: string; value: string; color: string }> = [];
  if (cwd) infoRows.push({ label: "Directory:", value: cwd, color: theme.inputText });
  if (sessionLabel) infoRows.push({ label: "Session:", value: sessionLabel, color: theme.muted });
  if (modelLine) infoRows.push({ label: "Model:", value: modelLine, color: theme.traceCommand });
  infoRows.push({ label: "Version:", value: PACKAGE_VERSION, color: theme.muted });
  const labelWidth = Math.max(...infoRows.map((row) => row.label.length)) + 1;

  return (
    <Box
      width={effectiveWidth}
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.bannerBorder}
      paddingX={2}
    >
      <Box flexDirection="row">
        <Box flexDirection="column" marginRight={2} flexShrink={0}>
          {COMPACT_LOGO.map((line, rowIndex) => (
            <Text
              key={`logo-row-${rowIndex}`}
              bold
              color={lerpColor(
                theme.bannerGradientFrom,
                theme.bannerGradientTo,
                COMPACT_LOGO.length <= 1 ? 0 : rowIndex / (COMPACT_LOGO.length - 1),
              )}
            >
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1} flexGrow={1} flexShrink={1}>
          <Box>
            <GradientText
              text="Welcome to Bubble!"
              from={theme.bannerGradientFrom}
              to={theme.bannerGradientTo}
            />
          </Box>
          <Text color={theme.muted} wrap="wrap">
            I am a cat and you can send /help for help information.
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {infoRows.map((row) => (
          <Box key={row.label} flexDirection="row">
            <Box flexShrink={0}>
              <Text color={theme.dim}>{row.label.padEnd(labelWidth)}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={row.color} wrap="wrap">{row.value}</Text>
            </Box>
          </Box>
        ))}
      </Box>
      {updateNotice && (
        <Box marginTop={1}>
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
