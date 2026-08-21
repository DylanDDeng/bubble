import chalk from "chalk";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@bubblebrain-ai/pi-tui";
import type { SubagentDisplay } from "../model/subagent-view.js";
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
}

const FINAL = new Set(["completed", "failed", "blocked", "cancelled", "closed"]);

function safe(value: string): string {
  return safeSheetText(value).replace(/[\r\n\t]+/g, " ").trim();
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function glyph(status: string): string {
  if (status === "completed" || status === "closed") return chalk.green("✓");
  if (status === "failed" || status === "blocked") return chalk.red("×");
  if (status === "cancelled") return chalk.gray("■");
  if (status === "queued") return chalk.gray("○");
  return chalk.cyan("◆");
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
    const snapshot = this.options.getSnapshot();
    if (!snapshot) return [chalk.red("Workflow is no longer available"), chalk.dim("Esc close")];
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
        ...members.map((member) => `${glyph(member.status ?? "running")} ${safe(member.nickname ?? member.agentName ?? "agent")}`),
      ].slice(0, terminalRows).map((row) => truncateToWidth(row, frameWidth, ""));
    }
    const top = chalk.gray(`┌─ ${truncateToWidth(title, Math.max(1, frameWidth - 6), "")} ${"─".repeat(Math.max(0, frameWidth - visibleWidth(title) - 5))}┐`);
    const header = `${chalk.gray("│")} ${pad(chalk.dim(`${done}/${members.length} agents · Enter inspect · x stop · Esc close`), inside)} ${chalk.gray("│")}`;
    const separator = chalk.gray(`├${"─".repeat(frameWidth - 2)}┤`);
    const rows: string[] = [];

    if (frameWidth >= 88) {
      const railWidth = Math.min(24, Math.max(16, Math.floor(inside * 0.27)));
      const rosterWidth = inside - railWidth - 3;
      const phaseRows = (phases.length > 0 ? phases : ["Workflow"]).map((phase) => `${phase === currentPhase ? chalk.cyan("◆") : chalk.dim("│")} ${safe(phase)}`);
      const rosterRows = members.slice(this.scrollOffset, this.scrollOffset + bodyBudget).map((member, index) => {
        const actualIndex = this.scrollOffset + index;
        const selected = actualIndex === this.selected;
        const line = `${selected ? chalk.cyan("›") : " "} ${glyph(member.status ?? "running")} ${safe(member.nickname ?? member.agentName ?? "agent")} — ${safe(member.task ?? "")}  ${chalk.dim(memberMeta(member))}`;
        return selected ? chalk.bgHex("#2B2B2B")(pad(line, rosterWidth)) : pad(line, rosterWidth);
      });
      for (let index = 0; index < bodyBudget; index += 1) {
        rows.push(`${chalk.gray("│")} ${pad(phaseRows[index] ?? "", railWidth)} ${chalk.dim("│")} ${pad(rosterRows[index] ?? "", rosterWidth)} ${chalk.gray("│")}`);
      }
    } else {
      const phaseLine = phases.length > 0
        ? phases.map((phase) => phase === currentPhase ? chalk.cyan(`◆ ${safe(phase)}`) : chalk.dim(`· ${safe(phase)}`)).join(chalk.dim("  →  "))
        : chalk.dim("◆ Workflow");
      rows.push(`${chalk.gray("│")} ${pad(phaseLine, inside)} ${chalk.gray("│")}`);
      const rosterBudget = Math.max(1, bodyBudget - 1);
      for (let index = 0; index < rosterBudget; index += 1) {
        const actualIndex = this.scrollOffset + index;
        const member = members[actualIndex];
        if (!member) {
          rows.push(`${chalk.gray("│")} ${pad("", inside)} ${chalk.gray("│")}`);
          continue;
        }
        const line = `${actualIndex === this.selected ? chalk.cyan("›") : " "} ${glyph(member.status ?? "running")} ${safe(member.nickname ?? member.agentName ?? "agent")} — ${safe(member.task ?? "")}  ${chalk.dim(memberMeta(member))}`;
        rows.push(`${chalk.gray("│")} ${actualIndex === this.selected ? chalk.bgHex("#2B2B2B")(pad(line, inside)) : pad(line, inside)} ${chalk.gray("│")}`);
      }
    }
    return [top, header, separator, ...rows, chalk.gray(`└${"─".repeat(frameWidth - 2)}┘`)];
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
