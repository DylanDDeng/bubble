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

const BAR_WIDTH = 10;

function budgetColor(percent: number): string {
  if (percent >= 90) return theme.contextCrit;
  if (percent >= 70) return theme.contextWarn;
  return theme.contextOk;
}

function renderBar(percent: number): { filled: string; empty: string; color: string } {
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * BAR_WIDTH);
  const filled = "█".repeat(filledCount);
  const empty = "░".repeat(BAR_WIDTH - filledCount);
  return { filled, empty, color: budgetColor(clamped) };
}

export function FooterBar({ data }: { data: FooterData }) {
  const usageText =
    data.usageTotals.prompt || data.usageTotals.completion
      ? `↑${formatTokens(data.usageTotals.prompt)} ↓${formatTokens(data.usageTotals.completion)}`
      : "";

  const thinkingText = data.showThinking
    ? data.thinkingLevel && data.thinkingLevel !== "off"
      ? ` • ⌃R ${data.thinkingLevel}`
      : " • ⌃R off"
    : "";
  const traceText = data.verboseTrace ? " • ⌃O details:on" : " • ⌃O details";

  const bar =
    data.budget?.contextWindow && data.budget.percent !== undefined
      ? renderBar(data.budget.percent)
      : null;
  const percentText =
    data.budget?.contextWindow && data.budget.percent !== undefined
      ? `${data.budget.percent.toFixed(1)}%`
      : data.budget?.estimatedTokens
        ? `~${formatTokens(data.budget.estimatedTokens)}`
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
      {bar && (
        <>
          <Text color={theme.muted}>  </Text>
          <Text color={bar.color}>{bar.filled}</Text>
          <Text color={theme.muted} dimColor>
            {bar.empty}
          </Text>
          <Text color={bar.color}> {percentText}</Text>
        </>
      )}
      {!bar && percentText && (
        <>
          <Text color={theme.muted}>  </Text>
          <Text color={theme.muted}>{percentText}</Text>
        </>
      )}
      <ModeBadge mode={data.mode} />
      <Box flexGrow={1} />
      <Text color={theme.muted}>{data.providerId}</Text>
      <Text color={theme.muted}> • </Text>
      <Text color={theme.toolName}>{data.model}</Text>
      <Text color={theme.muted} dimColor>
        {thinkingText}
        {traceText}
      </Text>
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
