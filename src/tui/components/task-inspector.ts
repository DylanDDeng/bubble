import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@bubblebrain-ai/pi-tui";
import { safeSheetText } from "./bottom-sheet.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";

export interface TaskInspectorOptions {
  id: string;
  title: string;
  getStatus(): string;
  getOutput(): string;
  getTerminalRows(): number;
  onClose(): void;
  onStop(): void;
  onCopy(): void | Promise<void>;
  onRender(): void;
  theme?: Theme;
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class TaskInspectorComponent implements Component {
  focused = false;
  private offset = 0;
  private follow = true;
  private bodyRows = 0;
  private contentRows = 0;
  constructor(private readonly options: TaskInspectorOptions) {}

  render(width: number): string[] {
    const theme = this.options.theme ?? darkTheme;
    const frameWidth = Math.max(1, Math.floor(width));
    const inside = Math.max(1, frameWidth - 4);
    const bodyRows = Math.max(3, this.options.getTerminalRows() - 6);
    const output = safeSheetText(this.options.getOutput()).split("\n");
    this.bodyRows = bodyRows;
    this.contentRows = output.length;
    const maxOffset = Math.max(0, output.length - bodyRows);
    if (this.follow) this.offset = maxOffset;
    const visible = output.slice(this.offset, this.offset + bodyRows);
    while (visible.length < bodyRows) visible.push("");
    const rawTitle = `${this.options.title} — ${this.options.getStatus()}`;
    if (frameWidth < 6) {
      return [rawTitle, ...visible]
        .slice(0, Math.max(1, this.options.getTerminalRows()))
        .map((line) => truncateToWidth(line, frameWidth, ""));
    }
    const title = truncateToWidth(rawTitle, frameWidth - 6, "");
    return [
      themeForeground(theme.border, `┌─ ${title} ${"─".repeat(Math.max(0, frameWidth - visibleWidth(title) - 5))}┐`),
      ...visible.map((line) => `${themeForeground(theme.border, "│")} ${pad(line, inside)} ${themeForeground(theme.border, "│")}`),
      `${themeForeground(theme.border, "│")} ${pad(themeDim(theme.dim, "↑↓ scroll · y copy · x stop · Esc close"), inside)} ${themeForeground(theme.border, "│")}`,
      themeForeground(theme.border, `└${"─".repeat(frameWidth - 2)}┘`),
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.options.onClose();
    if (data === "x" && this.options.getStatus() === "running") return this.options.onStop();
    if (data === "y") {
      void this.options.onCopy();
      return;
    }
    const maxOffset = Math.max(0, this.contentRows - this.bodyRows);
    if (matchesKey(data, "up") || data === "k") {
      this.follow = false;
      this.offset = Math.max(0, this.offset - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.offset = Math.min(maxOffset, this.offset + 1);
      this.follow = this.offset >= maxOffset;
    } else return;
    this.options.onRender();
  }

  invalidate(): void {}
}
