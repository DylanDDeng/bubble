import chalk from "chalk";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { WorkflowRunSnapshot } from "../../agent/workflow/control.js";
import type { BackgroundTaskInfo } from "../../tasks/manager.js";
import { darkTheme } from "../model/theme.js";
import { safeSheetText } from "./bottom-sheet.js";
import {
  latestSubagentNote,
  type SubagentDisplay,
  type SubagentGroup,
} from "../model/subagent-view.js";

export interface TasksPaneSnapshot {
  groups: SubagentGroup[];
  workflows: WorkflowRunSnapshot[];
  tasks: BackgroundTaskInfo[];
}

type PaneSection = "workflows" | "subagents" | "tasks";
export interface WorkflowPaneItem { kind: "workflow"; id: string; title: string; status: string; members: SubagentDisplay[]; createdAt?: number; updatedAt?: number }
export interface SubagentPaneItem { kind: "subagent"; id: string; title: string; status: string; member: SubagentDisplay }
export interface TaskPaneItem { kind: "task"; id: string; title: string; status: string; task: BackgroundTaskInfo }
export type PaneItem = WorkflowPaneItem | SubagentPaneItem | TaskPaneItem;

type RenderRow =
  | { kind: "header"; section: PaneSection }
  | { kind: "item"; item: PaneItem };

export interface TasksPaneCallbacks {
  onRender(): void;
  onOpenWorkflow(item: WorkflowPaneItem): void;
  onOpenSubagent(item: SubagentPaneItem): void;
  onOpenTask(item: TaskPaneItem): void;
  onStopWorkflow(id: string): void;
  onStopSubagent(id: string): void;
  onStopTask(id: string): void;
  onEscape(): void;
}

const FINAL = new Set(["completed", "failed", "blocked", "cancelled", "closed", "killed"]);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function isActive(status: string): boolean {
  return !FINAL.has(status);
}

function safe(value: string): string {
  return safeSheetText(value).replace(/[\r\n\t]+/g, " ").trim();
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function paint(line: string, width: number, state: "idle" | "hover" | "selected"): string {
  const filled = pad(line, width);
  if (state === "selected") return chalk.bgHex(darkTheme.traceSelectedBg)(filled);
  if (state === "hover") return chalk.bgHex(darkTheme.traceHoverBg)(filled);
  return filled;
}

function statusGlyph(status: string, frame: number): string {
  if (status === "completed" || status === "closed") return chalk.green("✓");
  if (status === "failed" || status === "blocked") return chalk.red("×");
  if (status === "cancelled" || status === "killed") return chalk.gray("■");
  if (status === "queued") return chalk.gray("○");
  return chalk.cyan(SPINNER[frame % SPINNER.length]!);
}

function elapsed(createdAt?: number, updatedAt?: number, active = true): string {
  if (!createdAt) return "";
  const ms = Math.max(0, (active ? Date.now() : updatedAt ?? Date.now()) - createdAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function usageLabel(member: SubagentDisplay): string {
  const usage = member.usage;
  if (!usage) return "";
  const total = usage.promptTokens + usage.completionTokens;
  return total >= 1000 ? `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k` : String(total);
}

function workflowMembers(workflow: WorkflowRunSnapshot, groups: SubagentGroup[]): SubagentDisplay[] {
  if (workflow.snapshots.length > 0) {
    return workflow.snapshots.map((snapshot) => ({
      subAgentId: snapshot.agentId,
      agentName: snapshot.agentName,
      nickname: snapshot.nickname,
      status: snapshot.status,
      category: snapshot.category,
      phase: snapshot.phase,
      route: snapshot.route,
      task: snapshot.task,
      summary: snapshot.summary,
      toolNotes: snapshot.toolNotes,
      error: snapshot.error,
      usage: snapshot.usage,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    }));
  }
  return groups.find((group) => group.kind === "workflow" && group.runId === workflow.runId)?.members ?? [];
}

function normalize(snapshot: TasksPaneSnapshot, showHistory: boolean): Record<PaneSection, PaneItem[]> {
  const workflowItems: PaneItem[] = snapshot.workflows.map((workflow) => ({
    kind: "workflow",
    id: workflow.runId,
    title: workflow.title,
    status: workflow.status,
    members: workflowMembers(workflow, snapshot.groups),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  }));
  const knownWorkflowRuns = new Set(snapshot.workflows.map((workflow) => workflow.runId));
  for (const group of snapshot.groups) {
    if (group.kind !== "workflow" || (group.runId && knownWorkflowRuns.has(group.runId))) continue;
    const statuses = group.members.map((member) => member.status ?? "running");
    const status = statuses.some(isActive)
      ? "running"
      : statuses.some((value) => value === "failed" || value === "blocked") ? "failed" : "completed";
    workflowItems.push({
      kind: "workflow",
      id: group.runId ?? group.id,
      title: group.label,
      status,
      members: group.members,
      createdAt: group.members.map((member) => member.createdAt).filter((value): value is number => value !== undefined).sort()[0],
      updatedAt: Math.max(0, ...group.members.map((member) => member.updatedAt ?? 0)),
    });
  }

  const subagentItems: PaneItem[] = snapshot.groups
    .filter((group) => group.kind !== "workflow")
    .flatMap((group) => group.members.map((member) => ({
      kind: "subagent" as const,
      id: member.subAgentId ?? group.id,
      title: member.nickname ?? member.agentName ?? group.label,
      status: member.status ?? "running",
      member,
    })));
  const taskItems: PaneItem[] = snapshot.tasks.map((task) => ({
    kind: "task",
    id: task.id,
    title: task.description || task.command,
    status: task.status,
    task,
  }));
  const filter = (items: PaneItem[]) => showHistory ? items : items.filter((item) => isActive(item.status));
  return {
    workflows: filter(workflowItems),
    subagents: filter(subagentItems),
    tasks: filter(taskItems),
  };
}

export class TasksPaneComponent implements Component {
  focused = false;
  private open = false;
  private manuallyClosed = false;
  private showHistory = false;
  private selectedId?: string;
  private hoveredId?: string;
  private lastActiveCount = 0;
  private lastRows: RenderRow[] = [];
  private allRows: RenderRow[] = [];
  private frame = 0;
  private timer: ReturnType<typeof setInterval>;
  private readonly collapsed = new Set<PaneSection>();

  constructor(
    private readonly getSnapshot: () => TasksPaneSnapshot,
    private readonly getTerminalRows: () => number,
    private readonly callbacks: TasksPaneCallbacks,
  ) {
    this.timer = setInterval(() => {
      if (this.activeCount() === 0) return;
      this.frame += 1;
      this.callbacks.onRender();
    }, 100);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  invalidate(): void {}

  isOpen(): boolean {
    return this.open && this.getTerminalRows() >= 12;
  }

  isAvailable(): boolean {
    return this.getTerminalRows() >= 12;
  }

  activeCount(): number {
    const items = normalize(this.getSnapshot(), true);
    return Object.values(items).flat().filter((item) => isActive(item.status)).length;
  }

  totalCount(): number {
    const items = normalize(this.getSnapshot(), true);
    return Object.values(items).flat().length;
  }

  activityGlyph(): string {
    return SPINNER[this.frame % SPINNER.length]!;
  }

  toggle(forceFocus = false): void {
    if (this.open && !forceFocus) {
      this.open = false;
      this.manuallyClosed = true;
    } else {
      this.open = true;
      this.manuallyClosed = false;
      // Once all activity has settled, Ctrl+G must remain a usable route back
      // to the completed child transcript. Opening an empty active-only pane
      // makes the work look lost even though the child session still exists.
      if (this.activeCount() === 0 && this.totalCount() > 0) this.showHistory = true;
    }
    this.callbacks.onRender();
  }

  close(): void {
    this.open = false;
    this.manuallyClosed = true;
    this.callbacks.onRender();
  }

  render(width: number): string[] {
    const terminalRows = this.getTerminalRows();
    if (terminalRows < 12) {
      this.lastRows = [];
      this.allRows = [];
      return [];
    }
    const activeCount = this.activeCount();
    if (activeCount > 0 && this.lastActiveCount === 0 && !this.manuallyClosed) this.open = true;
    if (activeCount === 0 && this.lastActiveCount > 0) {
      if (this.focused) {
        // A user who is already inspecting the pane should see the final
        // status land in place instead of watching the selected row vanish.
        this.showHistory = true;
      } else {
        this.open = false;
        this.manuallyClosed = false;
      }
    }
    this.lastActiveCount = activeCount;
    if (!this.open) {
      this.lastRows = [];
      this.allRows = [];
      return [];
    }

    const items = normalize(this.getSnapshot(), this.showHistory);
    const sections: Array<[PaneSection, string]> = [
      ["workflows", "Workflows"],
      ["subagents", "Subagents"],
      ["tasks", "Tasks"],
    ];
    const rows: RenderRow[] = [];
    for (const [section] of sections) {
      if (items[section].length === 0) continue;
      rows.push({ kind: "header", section });
      if (!this.collapsed.has(section)) rows.push(...items[section].map((item) => ({ kind: "item" as const, item })));
    }
    const itemRows = rows.filter((row): row is Extract<RenderRow, { kind: "item" }> => row.kind === "item");
    this.allRows = rows;
    if (!this.selectedId || !itemRows.some((row) => `${row.item.kind}:${row.item.id}` === this.selectedId)) {
      this.selectedId = itemRows[0] ? `${itemRows[0].item.kind}:${itemRows[0].item.id}` : undefined;
    }

    const maxRows = Math.max(3, Math.min(8, Math.floor(terminalRows * 0.15)));
    let start = 0;
    const selectedIndex = rows.findIndex((row) => row.kind === "item" && `${row.item.kind}:${row.item.id}` === this.selectedId);
    if (selectedIndex >= maxRows) start = selectedIndex - maxRows + 1;
    const visibleRows = rows.slice(start, start + maxRows);
    this.lastRows = visibleRows;
    return visibleRows.map((row) => {
      if (row.kind === "header") {
        const count = items[row.section].length;
        const marker = this.collapsed.has(row.section) ? "▸" : "▾";
        const label = sections.find(([section]) => section === row.section)?.[1] ?? row.section;
        return chalk.dim(pad(` ${marker} ${label} ${count}`, width));
      }
      const key = `${row.item.kind}:${row.item.id}`;
      const state = key === this.selectedId && this.focused ? "selected" : key === this.hoveredId ? "hover" : "idle";
      return paint(this.renderItem(row.item, width), width, state);
    });
  }

  private renderItem(item: PaneItem, width: number): string {
    const glyph = statusGlyph(item.status, this.frame);
    if (item.kind === "workflow") {
      const done = item.members.filter((member) => !isActive(member.status ?? "running")).length;
      const progress = item.members.length > 0 ? `${done}/${item.members.length}` : item.status;
      const duration = elapsed(item.createdAt, item.updatedAt, isActive(item.status));
      return truncateToWidth(`   ${glyph} ${safe(item.title)}  ${chalk.dim(`${progress}${duration ? ` · ${duration}` : ""}`)}${isActive(item.status) ? chalk.dim("  view  ×") : chalk.dim("  view")}`, width, "");
    }
    if (item.kind === "task") {
      const duration = elapsed(item.task.startedAt, item.task.endedAt, isActive(item.status));
      return truncateToWidth(`   ${glyph} ${safe(item.title)}  ${chalk.dim(`${item.status}${duration ? ` · ${duration}` : ""}`)}${isActive(item.status) ? chalk.dim("  view  ×") : chalk.dim("  view")}`, width, "");
    }
    const member = item.member;
    const activity = latestSubagentNote(member);
    const model = member.route?.model ?? member.agentName ?? "";
    const tokens = usageLabel(member);
    const duration = elapsed(member.createdAt, member.updatedAt, isActive(item.status));
    const meta = [model, tokens ? `${tokens} tok` : "", duration].filter(Boolean).join(" · ");
    const detail = activity ? ` — ${safe(activity)}` : "";
    return truncateToWidth(`   ${glyph} ${safe(item.title)}${detail}  ${chalk.dim(meta)}${isActive(item.status) ? chalk.dim("  view  ×") : chalk.dim("  view")}`, width, "");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.focused = false;
      this.callbacks.onEscape();
      return;
    }
    if (data === "h") {
      this.showHistory = !this.showHistory;
      this.callbacks.onRender();
      return;
    }
    const itemRows = this.allRows.filter((row): row is Extract<RenderRow, { kind: "item" }> => row.kind === "item");
    const index = Math.max(0, itemRows.findIndex((row) => `${row.item.kind}:${row.item.id}` === this.selectedId));
    if (matchesKey(data, "up") || data === "k") {
      const row = itemRows[Math.max(0, index - 1)];
      if (row) this.selectedId = `${row.item.kind}:${row.item.id}`;
      this.callbacks.onRender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      const row = itemRows[Math.min(itemRows.length - 1, index + 1)];
      if (row) this.selectedId = `${row.item.kind}:${row.item.id}`;
      this.callbacks.onRender();
      return;
    }
    const selected = itemRows.find((row) => `${row.item.kind}:${row.item.id}` === this.selectedId)?.item;
    if ((matchesKey(data, "left") || matchesKey(data, "right")) && selected) {
      const section: PaneSection = selected.kind === "workflow" ? "workflows" : selected.kind === "subagent" ? "subagents" : "tasks";
      if (matchesKey(data, "left")) this.collapsed.add(section); else this.collapsed.delete(section);
      this.callbacks.onRender();
      return;
    }
    if (matchesKey(data, "enter") && selected) this.openItem(selected);
    if (data === "x" && selected && isActive(selected.status)) this.stopItem(selected);
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") {
      const changed = this.hoveredId !== undefined;
      this.hoveredId = undefined;
      return changed;
    }
    const row = this.lastRows[event.y];
    if (event.kind === "move") {
      const next = row?.kind === "item" ? `${row.item.kind}:${row.item.id}` : undefined;
      const changed = next !== this.hoveredId;
      this.hoveredId = next;
      return changed;
    }
    if (event.release || (event.button & 3) !== 0 || !row) return false;
    if (row.kind === "header") {
      if (this.collapsed.has(row.section)) this.collapsed.delete(row.section); else this.collapsed.add(row.section);
      return true;
    }
    this.selectedId = `${row.item.kind}:${row.item.id}`;
    if (event.clickCount >= 2) this.openItem(row.item);
    return true;
  }

  private openItem(item: PaneItem): void {
    if (item.kind === "workflow") this.callbacks.onOpenWorkflow(item);
    else if (item.kind === "subagent") this.callbacks.onOpenSubagent(item);
    else this.callbacks.onOpenTask(item);
  }

  private stopItem(item: PaneItem): void {
    if (item.kind === "workflow") this.callbacks.onStopWorkflow(item.id);
    else if (item.kind === "subagent") this.callbacks.onStopSubagent(item.id);
    else this.callbacks.onStopTask(item.id);
  }
}

export class TaskStatusBarComponent implements Component {
  constructor(private readonly pane: TasksPaneComponent) {}

  render(width: number): string[] {
    if (!this.pane.isAvailable()) return [];
    const count = this.pane.activeCount();
    const total = this.pane.totalCount();
    if (total === 0 && !this.pane.isOpen()) return [];
    const marker = this.pane.isOpen() ? "▾" : "▸";
    const text = count > 0
      ? `${marker} ${chalk.cyan(this.pane.activityGlyph())} ${count} background activit${count === 1 ? "y" : "ies"} · Ctrl+G`
      : `${marker} ${chalk.green("✓")} ${total} completed activit${total === 1 ? "y" : "ies"} · Ctrl+G`;
    return [chalk.dim(truncateToWidth(` ${text}`, Math.max(1, width), ""))];
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind !== "press" || event.release || (event.button & 3) !== 0) return false;
    this.pane.toggle();
    return true;
  }

  invalidate(): void {}
}
