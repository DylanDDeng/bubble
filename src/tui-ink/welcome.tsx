import React from "react";
import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { useTheme, type Theme } from "./theme.js";
import type { DisplayMessage } from "./display-history.js";
import {
  bubbleWordmarkForWidth,
  type BubbleWordmarkLine,
  type BubbleWordmarkTone,
} from "../tui/wordmark.js";

interface WelcomeBannerProps {
  terminalColumns: number;
  tips: string[];
  /** One-line "update available" notice shown under the version. */
  updateNotice?: string;
}

interface WelcomeVisibilityInput {
  messages: Pick<DisplayMessage, "role" | "syntheticKind">[];
  startedWithVisibleHistory: boolean;
}

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();

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
}: WelcomeBannerProps) {
  const theme = useTheme();
  const effectiveWidth = Math.max(20, Math.min(terminalColumns - 2, 118));
  // Adaptive sizing: large pixel logo on wide terminals, standard, then the
  // single-line compact mark — same thresholds as the OpenTUI home screen.
  const logoLines = bubbleWordmarkForWidth(effectiveWidth);
  const actionableTips = tips
    .filter((item) => !item.startsWith("Ready with") && item.trim().length > 0)
    .slice(0, 2);
  const tip = actionableTips.length > 0
    ? actionableTips.join(" · ")
    : "Type / for commands and @ to reference files";

  return (
    <Box width={effectiveWidth} flexDirection="column" alignItems="center" marginBottom={1}>
      <Box flexDirection="column" alignItems="center">
        {logoLines.map((line, rowIndex) => (
          <LogoRow key={`logo-row-${rowIndex}`} line={line} />
        ))}
      </Box>
      <Box marginTop={2}>
        <Text bold color={theme.muted}>{PACKAGE_VERSION}</Text>
      </Box>
      {updateNotice && (
        <Box>
          <Text color={theme.accent}>{updateNotice}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text bold color={theme.userMessageText}>TIP: </Text>
        <Text bold color={theme.userMessageText}>{tip}</Text>
      </Box>
    </Box>
  );
}

function LogoRow({ line }: { line: BubbleWordmarkLine }) {
  const theme = useTheme();
  if (!line.segments) {
    return <Text bold color={logoColor(theme, line.tone ?? "caption")}>{line.text ?? ""}</Text>;
  }
  return (
    <Box>
      {line.segments.map((segment, index) => (
        <React.Fragment key={`${index}-${segment.text}`}>
          <Text bold color={logoColor(theme, segment.tone)}>
            {segment.text}
          </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

function logoColor(theme: Theme, tone: BubbleWordmarkTone): string {
  switch (tone) {
    case "brand": return theme.warning;
    case "ink": return theme.userMessageText;
    case "stone": return theme.muted;
    case "soft": return theme.dim;
    case "caption": return theme.muted;
  }
}

function readPackageVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ? `v${pkg.version}` : "v0.0.0";
  } catch {
    return "v0.0.0";
  }
}

