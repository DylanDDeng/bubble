import chalk from "chalk";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { SessionSummary } from "../../session.js";
import { formatRelativeTime } from "../recent-activity.js";
import { parseTerminalMouseWheel } from "../model/terminal-mouse.js";
import { darkTheme } from "../model/theme.js";

export type SessionPickerScope = "project" | "all";

export interface SessionPickerComponentOptions {
  currentCwd: string;
  currentSessions: SessionSummary[];
  allSessions: SessionSummary[];
  activeFile: string;
  getTerminalRows(): number;
  onSelect(file: string): void;
  onNewSession(): void;
  onClose(): void;
  onRender(): void;
}

type SessionRow =
  | { kind: "new"; key: "new" }
  | { kind: "header"; key: string; label: string }
  | { kind: "session"; key: string; session: SessionSummary };

interface HitRow {
  key: string;
  row: number;
}

const MAX_PANEL_HEIGHT = 30;
const PANEL_BACKGROUND = "#1F1F1F";

function fit(value: string, width: number, ellipsis = ""): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(value, width, ellipsis);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function alignSides(left: string, right: string, width: number): string {
  if (!right) return fit(left, width, "…");
  const gap = 2;
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width * 0.42)));
  const clippedRight = truncateToWidth(right, rightWidth, "…");
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - gap);
  return `${fit(left, leftWidth, "…")}${" ".repeat(gap)}${clippedRight}`;
}

function dedupeSessions(sessions: SessionSummary[]): SessionSummary[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.file)) return false;
    seen.add(session.file);
    return true;
  });
}

/** Centered session browser with project/all scopes and a first-class fresh-session action. */
export class SessionPickerComponent implements Component, Focusable {
  focused = false;
  private scope: SessionPickerScope = "project";
  private selectedKey = "new";
  private hoveredKey: string | undefined;
  private closeHovered = false;
  private hoveredTab: SessionPickerScope | undefined;
  private offset = 0;
  private bodyRows = 0;
  private frameWidth = 0;
  private rows: SessionRow[] = [];
  private selectableKeys: string[] = [];
  private hitRows: Array<HitRow | undefined> = [];
  private tabHits: Array<{ scope: SessionPickerScope; start: number; end: number }> = [];

  constructor(private readonly options: SessionPickerComponentOptions) {
    this.selectedKey = this.preferredKey(options.currentSessions);
  }

  render(width: number): string[] {
    const frameWidth = Math.max(1, Math.floor(width));
    const frameHeight = Math.max(1, Math.min(MAX_PANEL_HEIGHT, this.options.getTerminalRows() - 4));
    this.frameWidth = frameWidth;
    if (frameWidth < 40 || frameHeight < 10) {
      return [truncateToWidth("Sessions requires a 40 × 10 terminal · Esc close", frameWidth, "")]
        .slice(0, frameHeight);
    }

    const innerWidth = frameWidth - 2;
    const horizontal = "─".repeat(innerWidth);
    const close = this.closeHovered ? chalk.bold.white("[✗]") : chalk.gray("[✗]");
    const topDashCount = Math.max(0, frameWidth - 7);
    const top = `${chalk.gray("┌")}${chalk.gray("─".repeat(topDashCount))} ${close} ${chalk.gray("┐")}`;
    const bottom = chalk.gray(`└${horizontal}┘`);
    const separator = chalk.gray(`├${horizontal}┤`);
    const tabs = this.frameLine(this.renderTabs(innerWidth), innerWidth);

    this.rows = this.buildRows();
    this.selectableKeys = this.rows
      .filter((row) => row.kind !== "header")
      .map((row) => row.key);
    if (!this.selectableKeys.includes(this.selectedKey)) this.selectedKey = this.preferredKey(this.visibleSessions());

    this.bodyRows = Math.max(1, frameHeight - 5);
    const selectedRow = this.rows.findIndex((row) => row.key === this.selectedKey);
    if (selectedRow < this.offset) this.offset = selectedRow;
    if (selectedRow >= this.offset + this.bodyRows) this.offset = selectedRow - this.bodyRows + 1;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.rows.length - this.bodyRows)));

    const contentWidth = Math.max(1, innerWidth - 4);
    const visible = this.rows.slice(this.offset, this.offset + this.bodyRows);
    while (visible.length < this.bodyRows) visible.push({ kind: "header", key: `empty:${visible.length}`, label: "" });
    this.hitRows = [];
    const bodyStart = 3;
    const body = visible.map((row, index) => {
      const localY = bodyStart + index;
      const selectable = row.kind !== "header";
      if (selectable) this.hitRows[localY] = { key: row.key, row: localY };
      const selected = selectable && row.key === this.selectedKey;
      const hovered = selectable && row.key === this.hoveredKey;
      const text = this.renderRow(row, contentWidth);
      const padded = `  ${fit(text, contentWidth, "…")}  `;
      const styled = selected
        ? chalk.bgHex(darkTheme.traceSelectedBg).bold.white(fit(padded, innerWidth))
        : hovered
          ? chalk.bgHex(darkTheme.traceHoverBg).white(fit(padded, innerWidth))
          : chalk.bgHex(PANEL_BACKGROUND)(fit(padded, innerWidth));
      return `${chalk.gray("│")}${styled}${chalk.gray("│")}`;
    });
    const footer = this.frameLine(this.renderFooter(innerWidth), innerWidth);
    return [top, tabs, separator, ...body, footer, bottom]
      .slice(0, frameHeight)
      .map((line) => truncateToWidth(line, frameWidth, ""));
  }

  handleInput(data: string): void {
    const wheel = parseTerminalMouseWheel(data);
    if (wheel.length > 0) {
      for (const direction of wheel) this.move(direction === "up" ? -3 : 3);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.options.onClose();
    if (matchesKey(data, "tab")) return this.setScope(this.scope === "project" ? "all" : "project");
    if (matchesKey(data, "right") || data === "l") return this.setScope("all");
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || data === "h") return this.setScope("project");
    if (matchesKey(data, "up") || data === "k") return this.move(-1);
    if (matchesKey(data, "down") || data === "j") return this.move(1);
    if (matchesKey(data, "pageUp")) return this.move(-Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "pageDown")) return this.move(Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "home")) return this.selectAt(0);
    if (matchesKey(data, "end") || data === "G") return this.selectAt(this.selectableKeys.length - 1);
    if (matchesKey(data, "enter")) this.activate(this.selectedKey);
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") {
      const changed = this.closeHovered || this.hoveredKey !== undefined || this.hoveredTab !== undefined;
      this.closeHovered = false;
      this.hoveredKey = undefined;
      this.hoveredTab = undefined;
      return changed;
    }
    const overClose = event.y === 0
      && event.x >= Math.max(0, this.frameWidth - 6)
      && event.x < this.frameWidth - 1;
    const tab = this.tabHits.find((hit) => event.y === 1 && event.x >= hit.start && event.x < hit.end);
    const hit = this.hitRows[event.y];
    if (event.kind === "move") {
      const nextHovered = hit?.key;
      const nextTab = tab?.scope;
      const changed = this.closeHovered !== overClose || this.hoveredKey !== nextHovered || this.hoveredTab !== nextTab;
      this.closeHovered = overClose;
      this.hoveredKey = nextHovered;
      this.hoveredTab = nextTab;
      return changed;
    }
    if (event.release || (event.button & 3) !== 0) return false;
    if (overClose) {
      this.options.onClose();
      return true;
    }
    if (tab) {
      this.setScope(tab.scope);
      return true;
    }
    if (hit) {
      this.selectedKey = hit.key;
      this.activate(hit.key);
      return true;
    }
    return false;
  }

  invalidate(): void {}

  private visibleSessions(): SessionSummary[] {
    return this.scope === "project"
      ? dedupeSessions(this.options.currentSessions)
      : dedupeSessions(this.options.allSessions);
  }

  private buildRows(): SessionRow[] {
    const sessions = this.visibleSessions();
    const rows: SessionRow[] = [{ kind: "new", key: "new" }];
    if (this.scope === "project") {
      rows.push({ kind: "header", key: "header:project", label: this.options.currentCwd });
      rows.push(...sessions.map((session) => ({ kind: "session" as const, key: session.file, session })));
      return rows;
    }
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const key = session.cwdLabel;
      const group = grouped.get(key);
      if (group) group.push(session);
      else grouped.set(key, [session]);
    }
    const groups = [...grouped.entries()].sort((a, b) => {
      if (a[0] === this.options.currentCwd) return -1;
      if (b[0] === this.options.currentCwd) return 1;
      return (b[1][0]?.mtime ?? 0) - (a[1][0]?.mtime ?? 0);
    });
    for (const [label, group] of groups) {
      rows.push({ kind: "header", key: `header:${label}`, label });
      rows.push(...group.map((session) => ({ kind: "session" as const, key: session.file, session })));
    }
    return rows;
  }

  private renderRow(row: SessionRow, width: number): string {
    if (row.kind === "header") return row.label ? chalk.dim(truncateToWidth(row.label, width, "…")) : "";
    if (row.kind === "new") return alignSides(chalk.cyan("＋ New session"), chalk.dim("Start fresh"), width);
    const current = row.session.file === this.options.activeFile;
    const marker = current ? chalk.cyan("●") : " ";
    const label = `${marker} ${row.session.title || row.session.preview || row.session.name}`;
    const count = `${row.session.messageCount} msg${row.session.messageCount === 1 ? "" : "s"}`;
    const meta = current ? `${count} · current` : `${count} · ${formatRelativeTime(row.session.mtime)}`;
    return alignSides(label, chalk.dim(meta), width);
  }

  private renderTabs(width: number): string {
    const tabs: Array<{ scope: SessionPickerScope; label: string }> = [
      { scope: "project", label: "Current project" },
      { scope: "all", label: "All projects" },
    ];
    const pieces = ["  "];
    let cursor = 2;
    this.tabHits = [];
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index]!;
      if (index > 0) {
        pieces.push("   ");
        cursor += 3;
      }
      this.tabHits.push({ scope: tab.scope, start: cursor + 1, end: cursor + 1 + visibleWidth(tab.label) });
      const active = tab.scope === this.scope;
      const hovered = tab.scope === this.hoveredTab;
      pieces.push(active
        ? chalk.bgHex(darkTheme.traceSelectedBg).bold.white(tab.label)
        : hovered
          ? chalk.bgHex(darkTheme.traceHoverBg).white(tab.label)
          : chalk.gray(tab.label));
      cursor += visibleWidth(tab.label);
    }
    const count = `${this.visibleSessions().length} session${this.visibleSessions().length === 1 ? "" : "s"}`;
    return alignSides(pieces.join(""), chalk.dim(count), width);
  }

  private renderFooter(width: number): string {
    const plain = width >= 68
      ? "Tab/←/→ scope  |  ↑/↓ choose  |  Enter open  |  Esc close"
      : "Tab scope  |  ↑/↓ choose  |  Enter  |  Esc";
    const left = Math.max(0, Math.floor((width - visibleWidth(plain)) / 2));
    return fit(`${" ".repeat(left)}${chalk.dim(plain)}`, width);
  }

  private frameLine(content: string, width: number): string {
    return `${chalk.gray("│")}${fit(content, width)}${chalk.gray("│")}`;
  }

  private preferredKey(sessions: SessionSummary[]): string {
    return sessions.find((session) => session.file !== this.options.activeFile)?.file ?? "new";
  }

  private setScope(scope: SessionPickerScope): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.offset = 0;
    this.hoveredKey = undefined;
    const sessions = this.visibleSessions();
    if (!sessions.some((session) => session.file === this.selectedKey)) this.selectedKey = this.preferredKey(sessions);
    this.options.onRender();
  }

  private move(delta: number): void {
    if (this.selectableKeys.length === 0) return;
    const current = Math.max(0, this.selectableKeys.indexOf(this.selectedKey));
    this.selectAt(Math.max(0, Math.min(this.selectableKeys.length - 1, current + delta)));
  }

  private selectAt(index: number): void {
    const key = this.selectableKeys[index];
    if (!key || key === this.selectedKey) return;
    this.selectedKey = key;
    this.options.onRender();
  }

  private activate(key: string): void {
    if (key === "new") {
      this.options.onNewSession();
      return;
    }
    this.options.onSelect(key);
  }
}
