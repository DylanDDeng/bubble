import chalk from "chalk";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import {
  formatStatsPanelBody,
  rangeLabel,
  type StatsRange,
  type UsageStatsBundle,
} from "../../stats/usage.js";
import { parseTerminalMouseWheel } from "../model/terminal-mouse.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeBackground, themeDim, themeForeground } from "../model/theme-style.js";

const RANGES: Array<{ range: StatsRange; label: string }> = [
  { range: "7d", label: "Last 7 days" },
  { range: "30d", label: "Last 30 days" },
];
const MAX_PANEL_HEIGHT = 30;
const COLLAPSED_MODEL_ROWS = 5;

interface HitRange {
  start: number;
  end: number;
  row: number;
}

export interface StatsPanelComponentOptions {
  getTerminalRows(): number;
  onClose(): void;
  onRender(): void;
  theme?: Theme;
}

function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function formatGeneratedAt(value: Date): string {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function styleActivityLine(line: string, theme?: Theme): string {
  if (!theme) {
    return line.split(/([·○◉●])/u).map((part) => {
      if (part === "·") return chalk.gray.dim(part);
      if (part === "○") return chalk.cyan.dim(part);
      if (part === "◉") return chalk.cyan(part);
      if (part === "●") return chalk.magenta(part);
      return chalk.gray(part);
    }).join("");
  }
  return line.split(/([·○◉●])/u).map((part) => {
    if (part === "·") return themeDim(theme.dim, part);
    if (part === "○") return themeDim(theme.accent, part);
    if (part === "◉") return themeForeground(theme.accent, part);
    if (part === "●") return themeForeground(theme.thinking, part);
    return themeForeground(theme.muted, part);
  }).join("");
}

function isModelToggleLine(line: string): boolean {
  return line.includes("Show fewer models") || /Show \d+ more models?/u.test(line);
}

function styleBodyLine(line: string, theme?: Theme): string {
  if (line === "Activity" || line === "Model usage" || line === "Summary") {
    return theme ? chalk.bold(themeForeground(theme.inputText, line)) : chalk.bold.white(line);
  }
  if (/[·○◉●]/u.test(line)) return styleActivityLine(line, theme);
  if (isModelToggleLine(line)) return theme ? themeForeground(theme.accent, line) : chalk.cyan(line);
  return theme ? themeForeground(theme.muted, line) : chalk.gray(line);
}

export function buildStatsPanelLines(
  bundle: UsageStatsBundle,
  range: StatsRange,
  contentWidth: number,
  expandedModels = false,
  theme?: Theme,
): string[] {
  const stats = bundle.ranges[range];
  const body = formatStatsPanelBody(stats, Math.max(48, contentWidth), { expandedModels })
    .split("\n")
    .map((line) => styleBodyLine(line, theme));
  return [
    theme ? chalk.bold(themeForeground(theme.inputText, "Stats")) : chalk.bold.white("Stats"),
    "",
    theme
      ? themeForeground(theme.muted, `${rangeLabel(range)} · ${stats.startDate} – ${stats.endDate}`)
      : chalk.gray(`${rangeLabel(range)} · ${stats.startDate} – ${stats.endDate}`),
    theme
      ? themeDim(theme.dim, `Generated ${formatGeneratedAt(bundle.generatedAt)}`)
      : chalk.dim(`Generated ${formatGeneratedAt(bundle.generatedAt)}`),
    "",
    ...body,
  ];
}

/** A /context-style usage overlay with range switching and scrolling. */
export class StatsPanelComponent implements Component, Focusable {
  focused = false;
  private range: StatsRange = "30d";
  private offset = 0;
  private bodyRows = 0;
  private contentRows = 0;
  private frameWidth = 0;
  private tabHits: HitRange[] = [];
  private modelToggleHit: HitRange | undefined;
  private hoveredTab: number | undefined;
  private modelToggleHovered = false;
  private closeHovered = false;
  private modelsExpanded = false;

  constructor(
    private readonly bundle: UsageStatsBundle,
    private readonly options: StatsPanelComponentOptions,
  ) {}

  render(width: number): string[] {
    const theme = this.options.theme ?? darkTheme;
    const frameWidth = Math.max(1, Math.floor(width));
    const frameHeight = Math.max(1, Math.min(MAX_PANEL_HEIGHT, this.options.getTerminalRows() - 4));
    this.frameWidth = frameWidth;
    if (frameWidth < 8 || frameHeight < 5) {
      return [truncateToWidth("Stats · Esc close", frameWidth, "")].slice(0, frameHeight);
    }

    const innerWidth = frameWidth - 2;
    const horizontal = "─".repeat(Math.max(0, frameWidth - 2));
    const topDashCount = Math.max(0, frameWidth - 7);
    const close = this.closeHovered
      ? chalk.bold(themeForeground(theme.inputText, "[✗]"))
      : themeForeground(theme.muted, "[✗]");
    const top = themeForeground(theme.border, `┌${"─".repeat(topDashCount)}`) + ` ${close} ` + themeForeground(theme.border, "┐");
    const bottom = themeForeground(theme.border, `└${horizontal}┘`);
    const separator = themeForeground(theme.border, `├${horizontal}┤`);
    const tabLine = this.renderTabs(innerWidth);
    const contentWidth = Math.max(1, innerWidth - 4);
    const content = buildStatsPanelLines(
      this.bundle,
      this.range,
      contentWidth,
      this.modelsExpanded,
      this.options.theme,
    );

    this.bodyRows = Math.max(0, frameHeight - 5);
    this.contentRows = content.length;
    const maxOffset = Math.max(0, content.length - this.bodyRows);
    this.offset = Math.min(this.offset, maxOffset);
    const visible = content.slice(this.offset, this.offset + this.bodyRows);
    while (visible.length < this.bodyRows) visible.push("");
    this.modelToggleHit = undefined;
    const body = visible.map((line, index) => {
      const modelToggle = isModelToggleLine(line);
      if (modelToggle) {
        this.modelToggleHit = {
          start: 1,
          end: frameWidth - 1,
          row: 3 + index,
        };
      }
      const padded = `  ${fit(line, contentWidth)}  `;
      const decorated = modelToggle && this.modelToggleHovered
        ? themeForeground(theme.inputText, themeBackground(theme.traceHoverBg, padded))
        : padded;
      return this.frameLine(decorated, innerWidth);
    });
    const footer = this.frameLine(this.renderFooter(innerWidth), innerWidth);

    return [top, this.frameLine(tabLine, innerWidth), separator, ...body, footer, bottom]
      .slice(0, frameHeight)
      .map((line) => truncateToWidth(line, frameWidth, ""));
  }

  handleInput(data: string): void {
    const wheel = parseTerminalMouseWheel(data);
    if (wheel.length > 0) {
      for (const direction of wheel) this.scroll(direction === "up" ? -3 : 3);
      return;
    }
    if (matchesKey(data, "escape")) return this.options.onClose();
    if (matchesKey(data, "tab")) return this.stepRange(1);
    if (matchesKey(data, "shift+tab")) return this.stepRange(-1);
    if (matchesKey(data, "left") || data === "h" || data === "1") return this.selectRange("7d");
    if (matchesKey(data, "right") || data === "l" || data === "2") return this.selectRange("30d");
    if (data === "m") return this.toggleModels();
    if (matchesKey(data, "up") || data === "k") return this.scroll(-1);
    if (matchesKey(data, "down") || data === "j") return this.scroll(1);
    if (matchesKey(data, "pageUp")) return this.scroll(-Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "pageDown")) return this.scroll(Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "home")) return this.setOffset(0);
    if (matchesKey(data, "end") || data === "G") {
      return this.setOffset(Math.max(0, this.contentRows - this.bodyRows));
    }
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") {
      const changed = this.closeHovered || this.modelToggleHovered || this.hoveredTab !== undefined;
      this.closeHovered = false;
      this.modelToggleHovered = false;
      this.hoveredTab = undefined;
      return changed;
    }
    const overClose = event.y === 0
      && event.x >= Math.max(0, this.frameWidth - 6)
      && event.x < this.frameWidth - 1;
    const tabIndex = this.tabHits.findIndex((hit) => (
      event.y === hit.row && event.x >= hit.start && event.x < hit.end
    ));
    const overModelToggle = !!this.modelToggleHit
      && event.y === this.modelToggleHit.row
      && event.x >= this.modelToggleHit.start
      && event.x < this.modelToggleHit.end;
    if (event.kind === "move") {
      const nextTab = tabIndex >= 0 ? tabIndex : undefined;
      const changed = this.closeHovered !== overClose
        || this.modelToggleHovered !== overModelToggle
        || this.hoveredTab !== nextTab;
      this.closeHovered = overClose;
      this.modelToggleHovered = overModelToggle;
      this.hoveredTab = nextTab;
      return changed;
    }
    if (event.release || (event.button & 3) !== 0) return false;
    if (overClose) {
      this.options.onClose();
      return true;
    }
    const target = RANGES[tabIndex];
    if (target) {
      this.selectRange(target.range);
      return true;
    }
    if (overModelToggle) {
      this.toggleModels();
      return true;
    }
    return false;
  }

  invalidate(): void {}

  private frameLine(content: string, width: number): string {
    const theme = this.options.theme ?? darkTheme;
    return `${themeForeground(theme.border, "│")}${fit(content, width)}${themeForeground(theme.border, "│")}`;
  }

  private renderTabs(innerWidth: number): string {
    const theme = this.options.theme ?? darkTheme;
    const pieces = ["  "];
    let width = 2;
    this.tabHits = [];
    for (let index = 0; index < RANGES.length; index += 1) {
      const item = RANGES[index]!;
      const gap = index > 0 ? 3 : 0;
      if (gap > 0) {
        pieces.push("   ");
        width += gap;
      }
      const start = 1 + width;
      this.tabHits.push({ start, end: start + visibleWidth(item.label), row: 1 });
      const active = item.range === this.range;
      const hovered = index === this.hoveredTab;
      pieces.push(active
        ? chalk.bold(themeForeground(theme.inputText, themeBackground(theme.traceSelectedBg, item.label)))
        : hovered
          ? themeForeground(theme.inputText, themeBackground(theme.traceHoverBg, item.label))
          : themeForeground(theme.muted, item.label));
      width += visibleWidth(item.label);
    }
    return fit(pieces.join(""), innerWidth);
  }

  private renderFooter(innerWidth: number): string {
    const theme = this.options.theme ?? darkTheme;
    const plain = innerWidth >= 74 && this.bundle.ranges[this.range].models.length > COLLAPSED_MODEL_ROWS
      ? "m models  |  Tab/←/→ range  |  ↑/↓ scroll  |  Esc close"
      : innerWidth >= 62
      ? "Tab/←/→ range  |  ↑/↓ scroll  |  Esc close"
      : innerWidth >= 42
        ? "←/→ range  |  ↑/↓ scroll  |  Esc close"
        : "↑/↓ scroll  |  Esc close";
    const left = Math.max(0, Math.floor((innerWidth - visibleWidth(plain)) / 2));
    return fit(`${" ".repeat(left)}${themeDim(theme.dim, plain)}`, innerWidth);
  }

  private stepRange(direction: 1 | -1): void {
    const current = RANGES.findIndex((item) => item.range === this.range);
    const next = (current + direction + RANGES.length) % RANGES.length;
    this.selectRange(RANGES[next]!.range);
  }

  private selectRange(range: StatsRange): void {
    if (range === this.range) return;
    this.range = range;
    this.offset = 0;
    this.modelsExpanded = false;
    this.modelToggleHovered = false;
    this.options.onRender();
  }

  private toggleModels(): void {
    const modelCount = this.bundle.ranges[this.range].models.length;
    if (modelCount <= COLLAPSED_MODEL_ROWS) return;
    const insertedRows = modelCount - COLLAPSED_MODEL_ROWS;
    this.offset = this.modelsExpanded
      ? Math.max(0, this.offset - insertedRows)
      : this.offset + insertedRows;
    this.modelsExpanded = !this.modelsExpanded;
    this.modelToggleHovered = false;
    this.options.onRender();
  }

  private scroll(delta: number): void {
    this.setOffset(this.offset + delta);
  }

  private setOffset(value: number): void {
    const next = Math.max(0, Math.min(Math.max(0, this.contentRows - this.bodyRows), value));
    if (next === this.offset) return;
    this.offset = next;
    this.options.onRender();
  }
}
