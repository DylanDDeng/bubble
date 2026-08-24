/** Shared footer line renderer (main + fullscreen modes). */
import chalk from "chalk";
import { truncateToWidth, type Component } from "@bubblebrain-ai/pi-tui";
import { formatContextUsageLabel, friendlyCwd } from "./formatting/summary.js";
import { PERMISSION_MODE_INFO } from "../permission/mode.js";
import { classifyExternalRuntimeBinding } from "../external-runtime/session-policy.js";
import type { PermissionMode } from "../types.js";

export interface FooterAgentInfo {
  model: string;
  getContextUsageSnapshot(): { usedTokens: number; contextWindow?: number };
}

export interface FooterRenderOptions {
  cwd?: string;
  branch?: string;
  sessionTitle?: string;
  /** External runtimes own model/context state and replace native details. */
  runtimeLabel?: string;
  extra?: readonly string[];
  mode?: PermissionMode;
  /** Persistent autonomous Goal status, rendered on its own muted row. */
  goalLine?: string;
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
    const rows: string[] = [];
    if (snapshot.goalLine?.trim()) {
      rows.push(truncateToWidth(chalk.dim(snapshot.goalLine.trim()), Math.max(1, Math.floor(width))));
    }
    if (snapshot.runtimeLabel?.trim()) {
      rows.push(truncateToWidth(chalk.cyan(snapshot.runtimeLabel.trim()), Math.max(1, Math.floor(width))));
    }
    rows.push(renderFooterLine(snapshot.agent, width, snapshot));
    return rows;
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
  const nativeDetails = !options.runtimeLabel?.trim();
  const parts = [
    ...(mode ? [mode] : []),
    ...(nativeDetails && agent.model ? [chalk.dim(agent.model)] : []),
    chalk.dim(cwd),
    ...(options.branch?.trim() ? [chalk.dim(options.branch.trim())] : []),
    ...(nativeDetails && options.sessionTitle?.trim() ? [chalk.dim(options.sessionTitle.trim())] : []),
    ...(nativeDetails && usage ? [chalk.dim(usage)] : []),
    ...(options.extra ?? []),
  ];
  const line = parts.join(chalk.dim(" │ "));
  return truncateToWidth(line, Math.max(1, Math.floor(columns)));
}

/** Match the legacy footer contract for persisted external-runtime sessions. */
export function formatExternalRuntimeFooterLabel(binding: unknown): string | undefined {
  const kind = classifyExternalRuntimeBinding(binding);
  if (kind === "none") return undefined;
  if (kind === "unsupported") return "Unsupported external runtime · recovery-only";

  const record = binding && typeof binding === "object"
    ? binding as { modelId?: unknown; reasoningEffort?: unknown }
    : undefined;
  const model = typeof record?.modelId === "string" && record.modelId.trim()
    ? record.modelId.trim()
    : undefined;
  const effort = typeof record?.reasoningEffort === "string"
    && record.reasoningEffort.trim()
    && record.reasoningEffort !== "off"
    ? record.reasoningEffort.trim()
    : undefined;
  return ["Grok Subscription", model, effort, "workspace"].filter(Boolean).join(" · ");
}

export function renderPermissionModeBadge(mode?: PermissionMode): string {
  if (!mode || mode === "default") return "";
  const info = PERMISSION_MODE_INFO[mode];
  const label = `${info.symbol ? `${info.symbol} ` : ""}${info.shortTitle} on`;
  return mode === "bypassPermissions" ? chalk.bold.red(label) : chalk.bold.cyan(label);
}
