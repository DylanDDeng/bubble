/** @jsxImportSource @opentui/react */
import React from "react";
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
}

/**
 * Status row beneath the input composer. opencode-style: dim hints on the
 * left, provider + model + tokens on the right, separated by `·` middots.
 * No border, single row of muted text.
 */
export function FooterBar({ data }: { data: FooterData }) {
  const theme = useTheme();
  const usageText =
    data.usageTotals.prompt || data.usageTotals.completion
      ? `↑${formatTokens(data.usageTotals.prompt)} ↓${formatTokens(data.usageTotals.completion)}`
      : "";

  const thinkingText = data.showThinking
    ? data.thinkingLevel && data.thinkingLevel !== "off"
      ? `⌃R ${data.thinkingLevel}`
      : "⌃R off"
    : "";

  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
      {/* Status row: cwd + mode on left, model identity on right. */}
      <box style={{ paddingLeft: 2, paddingRight: 2, flexDirection: "row" }}>
        <text fg={theme.textMuted} content={formatCwd(data.cwd)} />
        <text fg={theme.textDim} content="  ·  " />
        <text fg={theme.accent} content={data.mode ? PERMISSION_MODE_INFO[data.mode]?.shortTitle ?? "default" : "default"} />
        {data.mode && data.mode !== "default" && (
          <text fg={theme.textDim} content=" ⇧⇥" />
        )}
        {usageText && (
          <>
            <text fg={theme.textDim} content="  ·  " />
            <text fg={theme.textMuted} content={usageText} />
          </>
        )}
        <box style={{ flexGrow: 1 }} />
        <text fg={theme.textDim} content={data.providerId} />
        <text fg={theme.textDim} content="  ·  " />
        <text fg={theme.text} attributes={1} content={data.model} />
        {thinkingText && (
          <>
            <text fg={theme.textDim} content="  ·  " />
            <text fg={theme.textMuted} content={thinkingText} />
          </>
        )}
      </box>
    </box>
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
