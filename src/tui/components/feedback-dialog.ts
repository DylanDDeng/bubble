import chalk from "chalk";
import {
  Editor,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@bubblebrain-ai/pi-tui";
import { FeedbackSubmitError, submitFeedback } from "../../feedback/submit.js";
import { redact } from "../../feedback/redact.js";
import type { FeedbackPayload, SubmitResult } from "../../feedback/types.js";
import { createComposerEditorTheme } from "../composer-style.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";
import { paintSheetLine, padSheetLine, safeSheetText } from "./bottom-sheet.js";

type FeedbackBase = Omit<FeedbackPayload, "description">;
type FeedbackStage = "edit" | "submitting" | "done";

export type FeedbackDialogResult =
  | { kind: "success"; url: string; number: number }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

export interface FeedbackDialogOptions {
  getTerminalRows(): number;
  getTheme?: () => Theme;
  submit?: (payload: FeedbackPayload) => Promise<SubmitResult>;
  onDismiss(): void;
  onResult(result: FeedbackDialogResult): void;
  onRender(): void;
}

/** Full-width, review-before-submit feedback workflow for the Pi TUI. */
export class FeedbackDialogComponent implements Component, Focusable {
  private readonly editor: Editor;
  private stage: FeedbackStage = "edit";
  private showPreview = false;
  private previewOffset = 0;
  private previewRows = 0;
  private previewContentRows = 0;
  private validationMessage: string | undefined;
  private finalResult: Exclude<FeedbackDialogResult, { kind: "cancelled" }> | undefined;
  private hasFocus = false;
  private dismissed = false;

  constructor(
    tui: TUI,
    private readonly base: FeedbackBase,
    initialDescription: string,
    private readonly options: FeedbackDialogOptions,
  ) {
    this.editor = new Editor(
      tui,
      createComposerEditorTheme(() => this.theme()),
      {
        borderStyle: "box",
        paddingX: 1,
        prompt: "",
        autocompletePlacement: "below",
        autocompleteBorderStyle: "none",
      },
    );
    this.editor.setText(safeSheetText(initialDescription));
    this.editor.onChange = (value) => {
      this.previewOffset = 0;
      if (value.trim() || this.base.transcript.length > 0) this.validationMessage = undefined;
    };
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.stage === "edit" && !this.showPreview;
  }

  render(width: number): string[] {
    const theme = this.theme();
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.options.getTerminalRows());
    const sheetRows = terminalRows > 1 ? Math.min(22, terminalRows - 1) : 1;
    const showHelp = sheetRows >= 4;
    const panelBudget = Math.max(1, sheetRows - (showHelp ? 1 : 0));
    const panel = this.stage === "submitting"
      ? this.renderSubmitting(safeWidth, panelBudget, theme)
      : this.stage === "done"
        ? this.renderDone(safeWidth, panelBudget, theme)
        : this.showPreview
          ? this.renderPreview(safeWidth, panelBudget, theme)
          : this.renderEditor(safeWidth, panelBudget, theme);
    const painted = panel.map((line) => paintSheetLine(line, safeWidth, false, theme));
    if (!showHelp) return painted;
    return [...painted, themeDim(theme.dim, padSheetLine(this.helpText(), safeWidth))];
  }

  handleInput(data: string): void {
    if (this.dismissed) return;
    if (this.stage === "submitting") return;
    if (this.stage === "done") {
      if (matchesKey(data, "enter") || matchesKey(data, "escape") || data === " ") this.dismiss();
      return;
    }

    if (matchesKey(data, "escape")) {
      this.options.onResult({ kind: "cancelled" });
      this.dismiss();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.showPreview = !this.showPreview;
      this.editor.focused = this.hasFocus && !this.showPreview;
      this.previewOffset = 0;
      this.options.onRender();
      return;
    }
    if (matchesKey(data, "ctrl+s") || matchesKey(data, "ctrl+d")) {
      this.startSubmit();
      return;
    }

    if (this.showPreview) {
      if (matchesKey(data, "up") || data === "k") {
        this.previewOffset = Math.max(0, this.previewOffset - 1);
      } else if (matchesKey(data, "down") || data === "j") {
        this.previewOffset = Math.min(this.maxPreviewOffset(), this.previewOffset + 1);
      }
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

  private startSubmit(): void {
    const payload = this.payload();
    if (!payload.description && payload.transcript.length === 0) {
      this.validationMessage = "Describe the issue before submitting.";
      this.showPreview = false;
      this.editor.focused = this.hasFocus;
      this.options.onRender();
      return;
    }

    this.validationMessage = undefined;
    this.stage = "submitting";
    this.editor.focused = false;
    this.options.onRender();
    const submit = this.options.submit ?? submitFeedback;
    void submit(payload).then((result) => {
      this.finalResult = { kind: "success", url: result.url, number: result.number };
      this.stage = "done";
      this.options.onResult(this.finalResult);
      this.options.onRender();
    }).catch((error: unknown) => {
      const message = error instanceof FeedbackSubmitError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.finalResult = { kind: "error", message };
      this.stage = "done";
      this.options.onResult(this.finalResult);
      this.options.onRender();
    });
  }

  private payload(): FeedbackPayload {
    return {
      description: redact(safeSheetText(this.editor.getExpandedText()).trim()),
      ...this.base,
    };
  }

  private renderEditor(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const stats = this.transcriptStats();
    const title = `${indent}${chalk.bold(themeForeground(theme.inputText, "Send feedback"))}`;
    const warning = `${indent}${themeForeground(theme.warning, "Creates a PUBLIC GitHub issue. Review the payload before sending.")}`;
    const label = `${indent}${themeForeground(theme.muted, "Describe what happened:")}`;
    const meta = `${indent}${themeDim(theme.dim, `Included: v${this.base.version} · ${this.base.platform}/${this.base.arch} · node ${this.base.nodeVersion} · ${this.base.provider}/${this.base.model} · ${stats.count} messages (${stats.totalChars} chars, secrets redacted)`)}`;
    if (budget <= 2) return [title, warning].slice(0, budget);

    const errorRows = this.validationMessage ? 1 : 0;
    const fixedRows = 4 + errorRows;
    const editorBudget = Math.max(1, budget - fixedRows);
    const editorLines = this.fitEditorWindow(this.editor.render(contentWidth), editorBudget);
    const lines = [title, warning, label, ...editorLines.map((line) => `${indent}${line}`), meta];
    if (this.validationMessage) {
      lines.push(`${indent}${themeForeground(theme.error, this.validationMessage)}`);
    }
    return lines.slice(0, budget);
  }

  private renderPreview(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const title = `${indent}${chalk.bold(themeForeground(theme.inputText, "Payload preview"))}`;
    const subtitle = `${indent}${themeDim(theme.dim, "Exact request body · ↑/↓ scroll · Tab return to editor")}`;
    if (budget <= 2) return [title, subtitle].slice(0, budget);

    const preview = safeSheetText(JSON.stringify(this.payload(), null, 2))
      .split("\n")
      .flatMap((line) => line ? wrapTextWithAnsi(line, contentWidth) : [""]);
    const bodyBudget = Math.max(0, budget - 2);
    this.previewRows = bodyBudget;
    this.previewContentRows = preview.length;
    this.previewOffset = Math.min(this.previewOffset, this.maxPreviewOffset());
    const visible = preview.slice(this.previewOffset, this.previewOffset + bodyBudget);
    while (visible.length < bodyBudget) visible.push("");
    return [
      title,
      subtitle,
      ...visible.map((line) => `${indent}${themeForeground(theme.muted, line)}`),
    ].slice(0, budget);
  }

  private renderSubmitting(width: number, budget: number, theme: Theme): string[] {
    const indent = " ".repeat(width >= 12 ? 2 : width >= 3 ? 1 : 0);
    return [
      `${indent}${chalk.bold(themeForeground(theme.inputText, "Sending feedback…"))}`,
      `${indent}${themeDim(theme.dim, "Creating the GitHub issue. Please wait.")}`,
    ].slice(0, budget);
  }

  private renderDone(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const result = this.finalResult;
    if (!result) return [`${indent}${themeForeground(theme.error, "Feedback result unavailable.")}`];
    if (result.kind === "success") {
      const url = wrapTextWithAnsi(safeSheetText(result.url), contentWidth)
        .map((line) => `${indent}${themeForeground(theme.accent, line)}`);
      return [
        `${indent}${chalk.bold(themeForeground(theme.success, "Feedback submitted"))}`,
        `${indent}${themeForeground(theme.inputText, `Thanks! Issue #${result.number} was created.`)}`,
        ...url,
      ].slice(0, budget);
    }
    const error = wrapTextWithAnsi(safeSheetText(result.message), contentWidth)
      .map((line) => `${indent}${themeForeground(theme.error, line)}`);
    return [
      `${indent}${chalk.bold(themeForeground(theme.error, "Feedback failed to submit"))}`,
      ...error,
    ].slice(0, budget);
  }

  private helpText(): string {
    if (this.stage === "submitting") return "Submitting feedback…";
    if (this.stage === "done") return "Enter/Space/Esc dismiss";
    if (this.showPreview) return "↑/↓ scroll  │  Tab edit  │  Ctrl+S/Ctrl+D submit  │  Esc cancel";
    return "Enter newline  │  Tab preview  │  Ctrl+S/Ctrl+D submit  │  Esc cancel";
  }

  private transcriptStats(): { count: number; totalChars: number } {
    return {
      count: this.base.transcript.length,
      totalChars: this.base.transcript.reduce((sum, message) => sum + message.content.length, 0),
    };
  }

  private maxPreviewOffset(): number {
    return Math.max(0, this.previewContentRows - this.previewRows);
  }

  private dismiss(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    this.options.onDismiss();
  }

  private theme(): Theme {
    return this.options.getTheme?.() ?? darkTheme;
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
