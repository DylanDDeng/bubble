import chalk from "chalk";
import {
  Editor,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@bubblebrain-ai/pi-tui";
import { createComposerEditorTheme } from "../composer-style.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";
import { paintSheetLine, padSheetLine, safeSheetText } from "./bottom-sheet.js";

type PlanDialogStage = "view" | "edit";

/**
 * Full-width plan approval sheet with an embedded multiline editor.
 *
 * Enter approves the proposed plan while viewing it. Editing deliberately
 * changes Enter to a newline; Ctrl+S/Ctrl+D is the explicit save-and-approve
 * action, matching the pre-migration Ink interaction.
 */
export class PlanDialogComponent implements Component, Focusable {
  private stage: PlanDialogStage = "view";
  private readonly editor: Editor;
  private viewOffset = 0;
  private viewRows = 0;
  private viewContentRows = 0;
  private validationMessage: string | undefined;
  private hasFocus = false;
  private readonly initialPlan: string;

  onApprove?: (plan: string) => void;
  onReject?: () => void;

  constructor(
    tui: TUI,
    initialPlan: string,
    private readonly getTerminalRows: () => number,
    private readonly getTheme: () => Theme = () => darkTheme,
  ) {
    // Plans originate in model output. Keep terminal control sequences out of
    // both the preview and the editable buffer.
    this.initialPlan = safeSheetText(initialPlan);
    this.editor = new Editor(
      tui,
      createComposerEditorTheme(getTheme),
      {
        borderStyle: "box",
        paddingX: 1,
        prompt: "",
        autocompletePlacement: "below",
        autocompleteBorderStyle: "none",
      },
    );
    this.editor.setText(this.initialPlan);
    this.editor.onChange = (value) => {
      if (value.trim()) this.validationMessage = undefined;
    };
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.stage === "edit";
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.getTerminalRows());
    // Long plans scroll inside a bounded sheet instead of covering the entire
    // transcript. On short terminals, keep one row of conversation visible.
    const sheetRows = terminalRows > 1
      ? Math.min(18, terminalRows - 1)
      : 1;
    const showHelp = sheetRows >= 4;
    const panelBudget = Math.max(1, sheetRows - (showHelp ? 1 : 0));
    const panel = this.stage === "edit"
      ? this.renderEditor(safeWidth, panelBudget, theme)
      : this.renderPlan(safeWidth, panelBudget, theme);
    const painted = panel.map((line) => paintSheetLine(line, safeWidth, false, theme));
    if (!showHelp) return painted;
    const help = this.stage === "edit"
      ? "Enter newline  │  Ctrl+S/Ctrl+D save & approve  │  Esc cancel edit"
      : "↑/↓ scroll  │  Enter/y approve  │  e edit  │  Esc/n reject";
    return [...painted, themeDim(theme.dim, padSheetLine(help, safeWidth))];
  }

  handleInput(data: string): void {
    if (this.stage === "view") {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "n" || data === "N") {
        this.onReject?.();
        return;
      }
      if (matchesKey(data, "enter") || data === "y" || data === "Y") {
        this.onApprove?.(this.initialPlan.trim());
        return;
      }
      if (data === "e" || data === "E") {
        this.enterEditStage();
        return;
      }
      if (matchesKey(data, "up") || data === "k") {
        this.viewOffset = Math.max(0, this.viewOffset - 1);
        return;
      }
      if (matchesKey(data, "down") || data === "j") {
        this.viewOffset = Math.min(this.maxViewOffset(), this.viewOffset + 1);
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.editor.setText(this.initialPlan);
      this.validationMessage = undefined;
      this.stage = "view";
      this.editor.focused = false;
      return;
    }
    if (matchesKey(data, "ctrl+s") || matchesKey(data, "ctrl+d")) {
      const finalPlan = this.editor.getExpandedText().trim();
      if (!finalPlan) {
        this.validationMessage = "Plan cannot be empty.";
        return;
      }
      this.onApprove?.(finalPlan);
      return;
    }
    if (matchesKey(data, "enter")) {
      this.editor.insertTextAtCursor("\n");
      return;
    }
    this.editor.handleInput(data);
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private enterEditStage(): void {
    this.stage = "edit";
    this.validationMessage = undefined;
    this.editor.setText(this.initialPlan);
    this.editor.focused = this.hasFocus;
  }

  private renderPlan(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const title = `${indent}${chalk.bold(themeForeground(theme.inputText, "Proposed plan"))}`;
    const action = (key: string, label: string) => `${indent}${themeForeground(theme.accent, key)} ${label}`;
    if (width < 24 && budget <= 3) {
      return [action("y", "approve"), action("e", "edit"), action("n", "reject")].slice(0, budget);
    }
    const actions = width < 40
      ? `${indent}${themeForeground(theme.accent, "y")} approve ${themeForeground(theme.accent, "e")} edit ${themeForeground(theme.accent, "n")} reject`
      : `${indent}${themeForeground(theme.accent, "y")} approve   ${themeForeground(theme.accent, "e")} edit   ${themeForeground(theme.accent, "n")} reject`;

    if (budget === 1) return [actions];

    const roomy = budget >= 6;
    const fixedRows = 2 + (roomy ? 2 : 0);
    const bodyBudget = Math.max(0, budget - fixedRows);
    const wrapped = safeSheetText(this.initialPlan)
      .split("\n")
      .flatMap((line) => line ? wrapTextWithAnsi(line, contentWidth) : [""]);
    this.viewRows = bodyBudget;
    this.viewContentRows = wrapped.length;
    this.viewOffset = Math.min(this.viewOffset, this.maxViewOffset());
    const visible = wrapped.slice(this.viewOffset, this.viewOffset + bodyBudget);
    while (visible.length < bodyBudget) visible.push("");

    return [
      title,
      ...(roomy ? [""] : []),
      ...visible.map((line) => `${indent}${themeForeground(theme.inputText, line)}`),
      ...(roomy ? [""] : []),
      actions,
    ].slice(0, budget);
  }

  private renderEditor(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const title = `${indent}${chalk.bold(themeForeground(theme.inputText, "Edit plan"))}`;
    if (budget === 1) return [title];

    const errorRows = this.validationMessage ? 1 : 0;
    const editorBudget = Math.max(1, budget - 1 - errorRows);
    const renderedEditor = this.editor.render(contentWidth);
    const visibleEditor = this.fitEditorWindow(renderedEditor, editorBudget);
    const lines = [title, ...visibleEditor.map((line) => `${indent}${line}`)];
    if (this.validationMessage) {
      lines.push(`${indent}${themeForeground(theme.error, this.validationMessage)}`);
    }
    return lines.slice(0, budget);
  }

  private maxViewOffset(): number {
    return Math.max(0, this.viewContentRows - this.viewRows);
  }

  private fitEditorWindow(lines: string[], budget: number): string[] {
    if (lines.length <= budget) return lines;
    if (budget <= 2) return lines.slice(-budget);

    const top = lines[0]!;
    const bottom = lines[lines.length - 1]!;
    const body = lines.slice(1, -1);
    const bodyBudget = budget - 2;
    const cursorIndex = Math.max(0, body.findIndex((line) => line.includes("\x1b[7m")));
    const start = Math.max(0, Math.min(
      cursorIndex - Math.floor(bodyBudget / 2),
      Math.max(0, body.length - bodyBudget),
    ));
    return [top, ...body.slice(start, start + bodyBudget), bottom];
  }
}
