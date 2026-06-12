import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { useTheme, type Theme } from "./theme.js";
import type { PermissionMode } from "../types.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";

export interface FooterUsageTotals {
  prompt: number;
  completion: number;
}

export interface FooterData {
  cwd: string;
  providerId: string;
  model: string;
  thinkingLevel: string;
  showThinking: boolean;
  mode?: PermissionMode;
  usageTotals: FooterUsageTotals;
  verboseTrace?: boolean;
  /** Context window fill (0-100). Replaces the OpenTUI sidebar gauge. */
  contextPercent?: number;
}

export function FooterBar({ data }: { data: FooterData }) {
  const theme = useTheme();
  const usageText =
    data.usageTotals.prompt || data.usageTotals.completion
      ? `↑${formatTokens(data.usageTotals.prompt)} ↓${formatTokens(data.usageTotals.completion)}`
      : "";

  const thinkingText = data.showThinking
    ? data.thinkingLevel && data.thinkingLevel !== "off"
      ? ` • ⌃R ${data.thinkingLevel}`
      : " • ⌃R off"
    : "";

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text color={theme.muted}>{formatCwd(data.cwd)}</Text>
      {usageText && (
        <>
          <Text color={theme.muted}>  </Text>
          <Text color={theme.muted} dimColor>
            {usageText}
          </Text>
        </>
      )}
      <ContextGauge percent={data.contextPercent} />
      <ModeBadge mode={data.mode} />
      <Box flexGrow={1} />
      <Text color={theme.muted}>{data.providerId}</Text>
      <Text color={theme.muted}> • </Text>
      <Text color={theme.toolName}>{data.model}</Text>
      <Text color={theme.muted} dimColor>
        {thinkingText}
      </Text>
    </Box>
  );
}

// Same alert thresholds as the OpenTUI sidebar gauge: ≥80% error, ≥60% warning.
function ContextGauge({ percent }: { percent?: number }) {
  const theme = useTheme();
  if (percent === undefined) return null;
  const color = percent >= 80 ? theme.error : percent >= 60 ? theme.warning : theme.muted;
  return (
    <>
      <Text color={theme.muted}>  </Text>
      <Text color={color} dimColor={percent < 60}>
        ctx {percent}%
      </Text>
    </>
  );
}

function ModeBadge({ mode }: { mode?: PermissionMode }) {
  const theme = useTheme();
  if (!mode || mode === "default") return null;
  const info = PERMISSION_MODE_INFO[mode];
  const color = (theme as unknown as Record<string, string>)[info.color] ?? theme.muted;
  const symbol = info.symbol ? `${info.symbol} ` : "";
  return (
    <>
      <Text color={theme.muted}>  </Text>
      <Text color={color} bold>
        {symbol}
        {info.shortTitle} on
      </Text>
      <Text color={theme.muted}> ⇧⇥</Text>
    </>
  );
}

export function buildFooterData(input: FooterData): FooterData {
  return input;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
