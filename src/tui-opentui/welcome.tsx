/** @jsxImportSource @opentui/react */
import React from "react";
import { createRequire } from "node:module";
import { useTheme, type Theme } from "./theme.js";
import type { DisplayMessage } from "./display-history.js";
import {
  BUBBLE_COMPACT_WORDMARK,
  BUBBLE_WORDMARK,
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

interface HomeSurfaceProps extends WelcomeBannerProps {
  terminalRows: number;
  composer: React.ReactNode;
}

interface WelcomeVisibilityInput {
  messages: Pick<DisplayMessage, "role" | "syntheticKind">[];
  startedWithVisibleHistory: boolean;
}

const require = createRequire(import.meta.url);
const PACKAGE_VERSION = readPackageVersion();

const WIDE_LOGO_MIN_WIDTH = bubbleWordmarkMaxWidth(BUBBLE_WORDMARK) + 4;

export function shouldShowWelcomeBanner({
  messages,
  startedWithVisibleHistory,
}: WelcomeVisibilityInput): boolean {
  if (startedWithVisibleHistory) return false;
  return !messages.some((message) => message.syntheticKind !== "ui_summary");
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
  const sessionLine = modelLabel
    ? `${modelLabel}${cwd ? ` · ${cwd}` : ""}`
    : cwd;

  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      {/* Logo: thin brand wordmark or compact single-line fallback. */}
      {useWideLogo ? (
        <box style={{ flexDirection: "column" }}>
          {BUBBLE_WORDMARK.map((line, i) => (
            <LogoRow key={`logo-row-${i}`} line={line} theme={theme} />
          ))}
        </box>
      ) : (
        <LogoRow line={BUBBLE_COMPACT_WORDMARK[0] ?? { text: "bubble βrain", tone: "ink" }} theme={theme} />
      )}

      {/* Metadata rows, opencode-style: padded label + bold value. */}
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        <MetaRow label="Version" value={PACKAGE_VERSION} theme={theme} />
        {sessionLine && <MetaRow label="Session" value={sessionLine} theme={theme} bold />}
        <MetaRow label="Tip" value={tip} theme={theme} />
        <MetaRow
          label="Status"
          value={statusSummary(skillsCount, mcpConnectedCount, mcpTotalCount, hasAgentsFile)}
          theme={theme}
        />
      </box>
    </box>
  );
}

function LogoRow({ line, theme }: { line: BubbleWordmarkLine; theme: Theme }) {
  if (!line.segments) {
    return (
      <text
        fg={logoColor(theme, line.tone ?? "caption")}
        attributes={1}
        content={line.text ?? ""}
      />
    );
  }
  return (
    <box style={{ flexDirection: "row" }}>
      {line.segments.map((segment, index) => (
        <text
          key={`${index}-${segment.text}`}
          fg={logoColor(theme, segment.tone)}
          attributes={1}
          content={segment.text}
        />
      ))}
    </box>
  );
}

function logoColor(theme: Theme, tone: BubbleWordmarkTone): string {
  switch (tone) {
    case "brand": return theme.warning;
    case "ink": return theme.text;
    case "stone": return theme.textMuted;
    case "soft": return theme.textDim;
    case "caption": return theme.textMuted;
  }
}

export function HomeSurface({
  terminalColumns,
  terminalRows,
  modelLabel,
  cwd,
  tips,
  skillsCount = 0,
  mcpConnectedCount = 0,
  mcpTotalCount = 0,
  hasAgentsFile = false,
  composer,
}: HomeSurfaceProps) {
  const theme = useTheme();
  const height = Math.max(18, terminalRows - 1);
  const effectiveWidth = Math.max(24, Math.min(terminalColumns - 4, 118));
  const composerWidth = Math.min(76, effectiveWidth);

  return (
    <box
      style={{
        height,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        paddingLeft: 2,
        paddingRight: 2,
      }}
    >
      <WelcomeBanner
        terminalColumns={effectiveWidth}
        modelLabel={modelLabel}
        cwd={cwd}
        tips={tips}
        skillsCount={skillsCount}
        mcpConnectedCount={mcpConnectedCount}
        mcpTotalCount={mcpTotalCount}
        hasAgentsFile={hasAgentsFile}
      />
      <box style={{ width: composerWidth, maxWidth: composerWidth, marginTop: 1 }}>
        {composer}
      </box>
      <box style={{ marginTop: 1 }}>
        <text fg={theme.textMuted} content="enter send · shift+enter newline · / commands · @ files" />
      </box>
    </box>
  );
}

function MetaRow({
  label,
  value,
  theme,
  bold,
}: {
  label: string;
  value: string;
  theme: Theme;
  bold?: boolean;
}) {
  // opencode uses 10-char left-padded labels in textMuted + bold value in text.
  const padded = label.padEnd(10, " ");
  return (
    <box style={{ flexDirection: "row" }}>
      <text fg={theme.textMuted} content={padded} />
      <text fg={theme.text} attributes={bold ? 1 : 0} content={value} />
    </box>
  );
}

function statusSummary(skills: number, mcpOn: number, mcpTotal: number, agents: boolean): string {
  const parts: string[] = [];
  parts.push(skills > 0 ? `${skills} skills` : "no skills");
  parts.push(mcpTotal === 0 ? "no MCPs" : `${mcpOn}/${mcpTotal} MCPs`);
  parts.push(agents ? "AGENTS.md ✓" : "AGENTS.md ×");
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
