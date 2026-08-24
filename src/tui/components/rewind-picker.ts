import chalk from "chalk";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { UserTurn } from "../../session.js";
import type { RewindScope } from "../../rewind.js";
import { safeSheetText } from "./bottom-sheet.js";

const PANEL_BACKGROUND = "#242424";
const SELECTED_BACKGROUND = "#3A3A3A";
const SCOPE_ORDER: RewindScope[] = ["all", "chat", "code"];

export const REWIND_SCOPE_LABEL: Record<RewindScope, string> = {
  all: "conversation + files",
  chat: "conversation only",
  code: "files only",
};

export interface RewindPickerPoint {
  turn: UserTurn;
  /** Oldest-first ordinal in SessionManager.listUserTurns(). */
  turnIndex: number;
  fileCount: number;
}

export type RewindPickerPhase =
  | "loading"
  | "picker"
  | "cancel-offer"
  | "confirm"
  | "executing"
  | "error";

export interface RewindPickerCallbacks {
  getTerminalRows(): number;
  onPreview(point: RewindPickerPoint, scope: RewindScope): void;
  onScopeChange(point: RewindPickerPoint | undefined, scope: RewindScope): void;
  onCancel(): void;
  onCancelRun(): void;
  onConfirm(point: RewindPickerPoint, scope: RewindScope): void;
  onRender(): void;
}

type HitRow =
  | { kind: "point"; index: number }
  | { kind: "cancel-choice"; index: number }
  | { kind: "confirm-choice"; index: number }
  | { kind: "dismiss" };

function fill(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function panelLine(text: string, width: number, selected = false): string {
  const safeWidth = Math.max(1, width);
  if (safeWidth === 1) return chalk.bgHex(PANEL_BACKGROUND)(chalk.cyan("▎"));
  const body = chalk.bgHex(selected ? SELECTED_BACKGROUND : PANEL_BACKGROUND)(fill(text, safeWidth - 1));
  return `${chalk.bgHex(PANEL_BACKGROUND)(chalk.cyan("▎"))}${body}`;
}

function cycleScope(scope: RewindScope, delta: 1 | -1): RewindScope {
  const index = SCOPE_ORDER.indexOf(scope);
  return SCOPE_ORDER[(index + delta + SCOPE_ORDER.length) % SCOPE_ORDER.length]!;
}

/** Grok-style prompt-area rewind sheet: filled surface, accent rail, and full-row selection. */
export class RewindPickerComponent implements Component, Focusable {
  focused = false;
  private phase: RewindPickerPhase;
  private points: RewindPickerPoint[] = [];
  private selected = 0;
  private choice = 0;
  private scope: RewindScope = "all";
  private error = "";
  private hitRows: Array<HitRow | undefined> = [];

  constructor(
    initialPhase: "picker" | "cancel-offer",
    points: RewindPickerPoint[],
    private readonly callbacks: RewindPickerCallbacks,
  ) {
    this.phase = initialPhase;
    this.setPoints(points);
  }

  getPhase(): RewindPickerPhase {
    return this.phase;
  }

  getSelectedPoint(): RewindPickerPoint | undefined {
    return this.points[this.selected];
  }

  showLoading(): void {
    this.phase = "loading";
    this.choice = 0;
    this.callbacks.onScopeChange(undefined, this.scope);
    this.callbacks.onRender();
  }

  showPicker(points: RewindPickerPoint[]): void {
    this.setPoints(points);
    if (this.points.length === 0) {
      this.showError("No undoable prompts.");
      return;
    }
    this.phase = "picker";
    this.choice = 0;
    this.emitPreview();
    this.callbacks.onRender();
  }

  showExecuting(): void {
    this.phase = "executing";
    this.callbacks.onRender();
  }

  showError(message: string): void {
    this.phase = "error";
    this.error = safeSheetText(message).replace(/\n+/g, " ");
    this.callbacks.onScopeChange(undefined, this.scope);
    this.callbacks.onRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    this.hitRows = [];
    switch (this.phase) {
      case "loading":
        return this.finish([this.line(chalk.gray("  Loading rewind points..."), safeWidth)], safeWidth);
      case "executing":
        return this.finish([this.line(chalk.gray("  Rewinding..."), safeWidth)], safeWidth);
      case "cancel-offer":
        return this.renderCancelOffer(safeWidth);
      case "confirm":
        return this.renderConfirm(safeWidth);
      case "error":
        return this.renderError(safeWidth);
      case "picker":
        return this.renderPicker(safeWidth);
    }
  }

  handleInput(data: string): void {
    if (this.phase === "loading" || this.phase === "executing") return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.callbacks.onCancel();
      return;
    }

    if (this.phase === "error") {
      if (matchesKey(data, "enter")) this.callbacks.onCancel();
      return;
    }
    if (this.phase === "picker") {
      if (matchesKey(data, "up") || data === "k") return this.movePoint(-1);
      if (matchesKey(data, "down") || data === "j") return this.movePoint(1);
      if (matchesKey(data, "pageUp")) return this.movePoint(-this.visiblePointBudget());
      if (matchesKey(data, "pageDown")) return this.movePoint(this.visiblePointBudget());
      if (matchesKey(data, "left") || data === "h" || matchesKey(data, "shift+tab")) return this.stepScope(-1);
      if (matchesKey(data, "right") || data === "l" || matchesKey(data, "tab")) return this.stepScope(1);
      if (matchesKey(data, "enter") && this.getSelectedPoint()) {
        this.phase = "confirm";
        this.choice = 0;
        this.callbacks.onRender();
      }
      return;
    }
    if (this.phase === "cancel-offer") {
      if (data === "y") return this.callbacks.onCancelRun();
      if (data === "n") return this.callbacks.onCancel();
      if (matchesKey(data, "up") || data === "k") return this.moveChoice(-1, 2);
      if (matchesKey(data, "down") || data === "j" || matchesKey(data, "tab")) return this.moveChoice(1, 2);
      if (matchesKey(data, "enter")) return this.activateCancelChoice();
      return;
    }
    if (data === "y") return this.confirm();
    if (data === "n") return this.callbacks.onCancel();
    if (matchesKey(data, "left") || data === "h" || matchesKey(data, "shift+tab")) return this.stepScope(-1);
    if (matchesKey(data, "right") || data === "l" || matchesKey(data, "tab")) return this.stepScope(1);
    if (matchesKey(data, "up") || data === "k") return this.moveChoice(-1, 2);
    if (matchesKey(data, "down") || data === "j") return this.moveChoice(1, 2);
    if (matchesKey(data, "enter")) {
      if (this.choice === 0) this.confirm();
      else this.callbacks.onCancel();
    }
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") return false;
    const hit = this.hitRows[event.y];
    if (!hit) return false;
    if (event.kind === "move") return this.hover(hit);
    if (event.release || (event.button & 3) !== 0) return false;
    this.hover(hit);
    this.activate(hit);
    return true;
  }

  invalidate(): void {}

  private renderPicker(width: number): string[] {
    const rows: string[] = [];
    rows.push(this.line(`  ${chalk.bold.cyan("Rewind to which turn?")}`, width));
    rows.push(this.line(`  ${chalk.dim("Restore:")} ${chalk.cyan(REWIND_SCOPE_LABEL[this.scope])}`, width));

    const budget = this.visiblePointBudget();
    const start = Math.max(0, Math.min(this.selected - budget + 1, Math.max(0, this.points.length - budget)));
    for (let index = start; index < Math.min(this.points.length, start + budget); index += 1) {
      const point = this.points[index]!;
      const selected = index === this.selected;
      const fileNote = point.fileCount > 0
        ? ` · ${point.fileCount} file${point.fileCount === 1 ? "" : "s"}`
        : "";
      const plain = `  · ${safeSheetText(point.turn.preview)}${fileNote}`;
      rows.push(this.line(selected ? chalk.bold.white(plain) : chalk.gray(plain), width, selected, { kind: "point", index }));
    }
    rows.push(this.line(chalk.dim("  ↑/↓ or j/k choose · ←/→ scope · Enter · Esc cancel"), width));
    return this.finish(rows, width);
  }

  private renderCancelOffer(width: number): string[] {
    const rows = [
      this.line(`  ${chalk.bold.cyan("A turn is currently running.")}`, width),
      this.line(chalk.gray("  Cancel it before rewinding?"), width),
      this.choiceLine("y", "Cancel turn and rewind", this.choice === 0, width, { kind: "cancel-choice", index: 0 }),
      this.choiceLine("n", "Let it finish", this.choice === 1, width, { kind: "cancel-choice", index: 1 }),
      this.line(chalk.dim("  ↑/↓ choose · Enter confirm · Esc dismiss"), width),
    ];
    return this.finish(rows, width);
  }

  private renderConfirm(width: number): string[] {
    const point = this.getSelectedPoint();
    const preview = point?.turn.preview ?? "this turn";
    const title = truncateToWidth(`  Rewind to “${safeSheetText(preview)}”?`, Math.max(1, width - 1), "…");
    const rows = [
      this.line(chalk.bold.cyan(title), width),
      this.line(`  ${chalk.dim("Restore:")} ${chalk.cyan(REWIND_SCOPE_LABEL[this.scope])} ${chalk.dim("(←/→ change)")}`, width),
      this.choiceLine("y", "Yes", this.choice === 0, width, { kind: "confirm-choice", index: 0 }),
      this.choiceLine("n", "No", this.choice === 1, width, { kind: "confirm-choice", index: 1 }),
      this.line(chalk.dim("  ↑/↓ choose · Enter confirm · Esc dismiss"), width),
    ];
    return this.finish(rows, width);
  }

  private renderError(width: number): string[] {
    const rows = [
      this.line(`  ${chalk.bold.red("Rewind failed")}`, width),
      this.line(`  ${chalk.white(this.error)}`, width),
      this.choiceLine("Esc", "Dismiss", true, width, { kind: "dismiss" }),
    ];
    return this.finish(rows, width);
  }

  private line(text: string, width: number, selected = false, hit?: HitRow): string {
    this.hitRows.push(hit);
    return panelLine(text, width, selected);
  }

  private choiceLine(key: string, label: string, selected: boolean, width: number, hit: HitRow): string {
    const marker = selected ? "●" : "○";
    const plain = `  ${key.padEnd(4)} (${marker}) ${label}`;
    return this.line(selected ? chalk.bold.white(plain) : chalk.gray(plain), width, selected, hit);
  }

  private finish(rows: string[], width: number): string[] {
    return rows.map((row) => truncateToWidth(row, Math.max(1, width), ""));
  }

  private setPoints(points: RewindPickerPoint[]): void {
    // Grok puts the newest rewind point first.
    this.points = [...points].sort((a, b) => b.turnIndex - a.turnIndex);
    this.selected = Math.min(this.selected, Math.max(0, this.points.length - 1));
  }

  private visiblePointBudget(): number {
    return Math.max(1, Math.min(10, this.callbacks.getTerminalRows() - 7));
  }

  private movePoint(delta: number): void {
    if (this.points.length === 0) return;
    const next = Math.max(0, Math.min(this.points.length - 1, this.selected + delta));
    if (next === this.selected) return;
    this.selected = next;
    this.emitPreview();
    this.callbacks.onRender();
  }

  private moveChoice(delta: number, count: number): void {
    this.choice = Math.max(0, Math.min(count - 1, this.choice + delta));
    this.callbacks.onRender();
  }

  private stepScope(delta: 1 | -1): void {
    this.scope = cycleScope(this.scope, delta);
    this.callbacks.onScopeChange(this.getSelectedPoint(), this.scope);
    this.callbacks.onRender();
  }

  private emitPreview(): void {
    const point = this.getSelectedPoint();
    if (point) this.callbacks.onPreview(point, this.scope);
  }

  private confirm(): void {
    const point = this.getSelectedPoint();
    if (point) this.callbacks.onConfirm(point, this.scope);
  }

  private activateCancelChoice(): void {
    if (this.choice === 0) this.callbacks.onCancelRun();
    else this.callbacks.onCancel();
  }

  private hover(hit: HitRow): boolean {
    if (hit.kind === "point") {
      if (hit.index === this.selected) return false;
      this.selected = hit.index;
      this.emitPreview();
      return true;
    }
    if (hit.kind === "cancel-choice" || hit.kind === "confirm-choice") {
      if (hit.index === this.choice) return false;
      this.choice = hit.index;
      return true;
    }
    return false;
  }

  private activate(hit: HitRow): void {
    if (hit.kind === "point") {
      this.phase = "confirm";
      this.choice = 0;
      return;
    }
    if (hit.kind === "cancel-choice") return this.activateCancelChoice();
    if (hit.kind === "confirm-choice") {
      if (hit.index === 0) this.confirm();
      else this.callbacks.onCancel();
      return;
    }
    this.callbacks.onCancel();
  }
}
