import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { theme } from "./theme.js";
import type { PermissionMode } from "../types.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";

export interface FooterUsageTotals {
  prompt: number;
  completion: number;
}

export interface FooterBudget {
  estimatedTokens: number;
  contextWindow?: number;
  percent?: number;
}

export interface FooterData {
  cwd: string;
  providerId: string;
  model: string;
  thinkingLevel: string;
  showThinking: boolean;
  mode?: PermissionMode;
  usageTotals: FooterUsageTotals;
  budget?: FooterBudget;
  verboseTrace?: boolean;
}

export function FooterBar({ data }: { data: FooterData }) {
  const usageText = data.usageTotals.prompt || data.usageTotals.completion
    ? `  ↑${formatTokens(data.usageTotals.prompt)} ↓${formatTokens(data.usageTotals.completion)}`
    : "";
  const budgetText = data.budget?.contextWindow && data.budget.percent !== undefined
    ? `  ${data.budget.percent.toFixed(1)}%/${formatTokens(data.budget.contextWindow)}`
    : data.budget?.estimatedTokens
      ? `  ~${formatTokens(data.budget.estimatedTokens)}`
      : "";

  const thinkingText = data.showThinking
    ? (data.thinkingLevel && data.thinkingLevel !== "off" ? ` • ⌃R ${data.thinkingLevel}` : " • ⌃R thinking off")
    : "";
  const traceText = data.verboseTrace ? " • ⌃O trace:on" : " • ⌃O trace";
  const left = `${formatCwd(data.cwd)}${usageText}${budgetText}`;
  const right = `${data.providerId} • ${data.model}${thinkingText}${traceText}`;

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text color={theme.muted}>{left}</Text>
      <ModeBadge mode={data.mode} />
      <Box flexGrow={1} />
      <Text color={theme.muted}>{right}</Text>
    </Box>
  );
}

function ModeBadge({ mode }: { mode?: PermissionMode }) {
  if (!mode || mode === "default") return null;
  const info = PERMISSION_MODE_INFO[mode];
  const color = theme[info.color] ?? theme.muted;
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
