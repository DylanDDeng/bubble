import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@bubblebrain-ai/pi-tui";
import type { SubagentDisplay } from "../model/subagent-view.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeBackground, themeDim, themeForeground } from "../model/theme-style.js";
import { safeSheetText } from "./bottom-sheet.js";

export interface WorkflowInspectorSnapshot {
  id: string;
  title: string;
  status: string;
  members: SubagentDisplay[];
  createdAt?: number;
  updatedAt?: number;
}

export interface WorkflowInspectorOptions {
  getSnapshot(): WorkflowInspectorSnapshot | undefined;
  getTerminalRows(): number;
  onClose(): void;
  onOpenAgent(agentId: string): void;
  onStop(runId: string): void;
  onRender(): void;
  theme?: Theme;
}

const FINAL = new Set(["completed", "failed", "blocked", "cancelled", "closed"]);

function safe(value: string): string {
  return safeSheetText(value).replace(/[\r\n\t]+/g, " ").trim();
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function glyph(status: string, theme: Theme): string {
  if (status === "completed" || status === "closed") return themeForeground(theme.success, "✓");
  if (status === "failed" || status === "blocked") return themeForeground(theme.error, "×");
  if (status === "cancelled") return themeForeground(theme.muted, "■");
  if (status === "queued") return themeForeground(theme.muted, "○");
  return themeForeground(theme.accent, "◆");
}

function memberMeta(member: SubagentDisplay): string {
  const tokens = member.usage ? member.usage.promptTokens + member.usage.completionTokens : 0;
  const duration = member.createdAt
    ? Math.floor((((FINAL.has(member.status ?? "") ? member.updatedAt : Date.now()) ?? Date.now()) - member.createdAt) / 1000)
    : 0;
  return [member.route?.model ?? member.agentName, tokens ? `${tokens} tok` : "", duration ? `${duration}s` : ""].filter(Boolean).join(" · ");
}

export class WorkflowInspectorComponent implements Component {
  focused = false;
  private selected = 0;
  private scrollOffset = 0;

  constructor(private readonly options: WorkflowInspectorOptions) {}

  render(width: number): string[] {
    const theme = this.options.theme ?? darkTheme;
    const snapshot = this.options.getSnapshot();
    if (!snapshot) return [
      themeForeground(theme.error, "Workflow is no longer available"),
      themeDim(theme.dim, "Esc close"),
    ];
    const frameWidth = Math.max(1, Math.floor(width));
    const inside = Math.max(1, frameWidth - 4);
    const members = snapshot.members;
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, members.length - 1)));
    const terminalRows = Math.max(8, this.options.getTerminalRows());
    const bodyBudget = Math.max(3, terminalRows - 7);
    if (this.selected < this.scrollOffset) this.scrollOffset = this.selected;
    if (this.selected >= this.scrollOffset + bodyBudget) this.scrollOffset = this.selected - bodyBudget + 1;

    const done = members.filter((member) => FINAL.has(member.status ?? "running")).length;
    const phases = [...new Set(members.map((member) => member.phase).filter((phase): phase is string => !!phase))];
    const currentPhase = [...members].reverse().find((member) => !FINAL.has(member.status ?? "running"))?.phase ?? phases.at(-1);
    const title = `${snapshot.title} — ${snapshot.status}`;
    if (frameWidth < 6) {
      return [
        title,
        `${done}/${members.length}`,
        ...members.map((member) => `${glyph(member.status ?? "running", theme)} ${safe(member.nickname ?? member.agentName ?? "agent")}`),
      ].slice(0, terminalRows).map((row) => truncateToWidth(row, frameWidth, ""));
    }
    const border = (text: string) => themeForeground(theme.border, text);
    const accent = (text: string) => themeForeground(theme.accent, text);
    const dim = (text: string) => themeDim(theme.dim, text);
    const selectedBackground = (text: string) => themeBackground(theme.traceSelectedBg, text);
    const top = border(`┌─ ${truncateToWidth(title, Math.max(1, frameWidth - 6), "")} ${"─".repeat(Math.max(0, frameWidth - visibleWidth(title) - 5))}┐`);
    const header = `${border("│")} ${pad(dim(`${done}/${members.length} agents · Enter inspect · x stop · Esc close`), inside)} ${border("│")}`;
    const separator = border(`├${"─".repeat(frameWidth - 2)}┤`);
    const rows: string[] = [];

    if (frameWidth >= 88) {
      const railWidth = Math.min(24, Math.max(16, Math.floor(inside * 0.27)));
      const rosterWidth = inside - railWidth - 3;
      const phaseRows = (phases.length > 0 ? phases : ["Workflow"]).map((phase) => `${phase === currentPhase ? accent("◆") : dim("│")} ${safe(phase)}`);
      const rosterRows = members.slice(this.scrollOffset, this.scrollOffset + bodyBudget).map((member, index) => {
        const actualIndex = this.scrollOffset + index;
        const selected = actualIndex === this.selected;
        const line = `${selected ? accent("›") : " "} ${glyph(member.status ?? "running", theme)} ${safe(member.nickname ?? member.agentName ?? "agent")} — ${safe(member.task ?? "")}  ${dim(memberMeta(member))}`;
        return selected ? selectedBackground(pad(line, rosterWidth)) : pad(line, rosterWidth);
      });
      for (let index = 0; index < bodyBudget; index += 1) {
        rows.push(`${border("│")} ${pad(phaseRows[index] ?? "", railWidth)} ${dim("│")} ${pad(rosterRows[index] ?? "", rosterWidth)} ${border("│")}`);
      }
    } else {
      const phaseLine = phases.length > 0
        ? phases.map((phase) => phase === currentPhase ? accent(`◆ ${safe(phase)}`) : dim(`· ${safe(phase)}`)).join(dim("  →  "))
        : dim("◆ Workflow");
      rows.push(`${border("│")} ${pad(phaseLine, inside)} ${border("│")}`);
      const rosterBudget = Math.max(1, bodyBudget - 1);
      for (let index = 0; index < rosterBudget; index += 1) {
        const actualIndex = this.scrollOffset + index;
        const member = members[actualIndex];
        if (!member) {
          rows.push(`${border("│")} ${pad("", inside)} ${border("│")}`);
          continue;
        }
        const line = `${actualIndex === this.selected ? accent("›") : " "} ${glyph(member.status ?? "running", theme)} ${safe(member.nickname ?? member.agentName ?? "agent")} — ${safe(member.task ?? "")}  ${dim(memberMeta(member))}`;
        rows.push(`${border("│")} ${actualIndex === this.selected ? selectedBackground(pad(line, inside)) : pad(line, inside)} ${border("│")}`);
      }
    }
    return [top, header, separator, ...rows, border(`└${"─".repeat(frameWidth - 2)}┘`)];
  }

  handleInput(data: string): void {
    const snapshot = this.options.getSnapshot();
    if (matchesKey(data, "escape")) {
      this.options.onClose();
      return;
    }
    if (!snapshot) return;
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(Math.max(0, snapshot.members.length - 1), this.selected + 1);
    else if (matchesKey(data, "enter")) {
      const id = snapshot.members[this.selected]?.subAgentId;
      if (id) this.options.onOpenAgent(id);
      return;
    } else if (data === "x" && !FINAL.has(snapshot.status)) {
      this.options.onStop(snapshot.id);
      return;
    } else return;
    this.options.onRender();
  }

  invalidate(): void {}
}
