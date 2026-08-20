/** Shared footer line renderer (main + fullscreen modes). */
import chalk from "chalk";
import { truncateToWidth, type Component } from "@bubblebrain-ai/pi-tui";
import { formatContextUsageLabel, friendlyCwd } from "./formatting/summary.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";
import type { PermissionMode } from "../types.js";

export interface FooterAgentInfo {
  model: string;
  getContextUsageSnapshot(): { usedTokens: number; contextWindow?: number };
}

export interface FooterRenderOptions {
  cwd?: string;
  extra?: readonly string[];
  mode?: PermissionMode;
}

export interface ResponsiveFooterSnapshot extends FooterRenderOptions {
  agent: FooterAgentInfo;
  hidden?: boolean;
}

/** Width-responsive single-row footer shared by main and fullscreen TUIs. */
export class ResponsiveFooterComponent implements Component {
  constructor(private readonly getSnapshot: () => ResponsiveFooterSnapshot) {}

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    if (snapshot.hidden) return [];
    return [renderFooterLine(snapshot.agent, width, snapshot)];
  }

  invalidate(): void {
    // No cache: terminal width, model, cwd, usage, and queue badges are live.
  }
}

export function renderFooterLine(
  agent: FooterAgentInfo,
  columns: number,
  options: FooterRenderOptions = {},
): string {
  const usage = formatContextUsageLabel(agent.getContextUsageSnapshot());
  const cwd = options.cwd ?? friendlyCwd(process.cwd());
  const mode = renderPermissionModeBadge(options.mode);
  const parts = [
    ...(mode ? [mode] : []),
    chalk.dim(agent.model),
    chalk.dim(cwd),
    chalk.dim(usage),
    ...(options.extra ?? []),
  ];
  const line = parts.join(chalk.dim(" │ "));
  return truncateToWidth(line, Math.max(1, Math.floor(columns)));
}

export function renderPermissionModeBadge(mode?: PermissionMode): string {
  if (!mode || mode === "default") return "";
  const info = PERMISSION_MODE_INFO[mode];
  const label = `${info.symbol ? `${info.symbol} ` : ""}${info.shortTitle} on`;
  return mode === "bypassPermissions" ? chalk.bold.red(label) : chalk.bold.cyan(label);
}
