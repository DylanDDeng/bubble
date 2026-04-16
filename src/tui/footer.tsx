import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { theme } from "./theme.js";

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
  usageTotals: FooterUsageTotals;
  budget?: FooterBudget;
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

  const left = `${formatCwd(data.cwd)}${usageText}${budgetText}`;
  const right = `${data.providerId} • ${data.model}${data.thinkingLevel && data.thinkingLevel !== "off" ? ` • ${data.thinkingLevel}` : " • thinking off"}`;

  return (
    <Box paddingX={1} flexShrink={0}>
      <Text color={theme.muted}>{left}</Text>
      <Box flexGrow={1} />
      <Text color={theme.muted}>{right}</Text>
    </Box>
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
