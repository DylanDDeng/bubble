import React from "react";
import { Box, Text } from "ink";
import { createRequire } from "node:module";
import { useTheme, type Theme } from "./theme.js";
import type { DisplayMessage } from "./display-history.js";
import {
  BUBBLE_COMPACT_WORDMARK,
  BUBBLE_WORDMARK,
  bubbleWordmarkLineText,
  bubbleWordmarkMaxWidth,
  type BubbleWordmarkLine,
  type BubbleWordmarkTone,
} from "../tui/wordmark.js";

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

const WIDE_LOGO_MIN_WIDTH = bubbleWordmarkMaxWidth(BUBBLE_WORDMARK) + 4;

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
          ? BUBBLE_WORDMARK.map((line, rowIndex) => (
            <LogoRow key={`logo-row-${rowIndex}`} line={line} />
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

function CompactLogo() {
  const theme = useTheme();
  const line = BUBBLE_COMPACT_WORDMARK[0];
  if (!line?.segments) {
    return <Text bold color={theme.warning}>{bubbleWordmarkLineText(line ?? { text: "" })}</Text>;
  }
  return (
    <Box>
      {line.segments.map((segment, index) => (
        <Text key={`${segment.text}-${index}`} bold color={logoColor(theme, segment.tone)}>
          {segment.text}
        </Text>
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
