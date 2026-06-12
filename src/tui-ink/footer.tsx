import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { useTheme, type Theme } from "./theme.js";
import type { PermissionMode } from "../types.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";

export interface FooterData {
  cwd: string;
  providerId: string;
  model: string;
  thinkingLevel: string;
  showThinking: boolean;
  mode?: PermissionMode;
  verboseTrace?: boolean;
}

export function FooterBar({ data }: { data: FooterData }) {
  const theme = useTheme();
  const thinkingText = data.showThinking
    ? data.thinkingLevel && data.thinkingLevel !== "off"
      ? ` • ⌃R ${data.thinkingLevel}`
      : " • ⌃R off"
    : "";

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text color={theme.muted}>{formatCwd(data.cwd)}</Text>
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

function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
