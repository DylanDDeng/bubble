import chalk from "chalk";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@bubblebrain-ai/pi-tui";
import type { QuestionAnswer, QuestionRequest } from "../../question/types.js";
import { paintSheetLine, padSheetLine, safeSheetInlineText, safeSheetText } from "./bottom-sheet.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";

interface ChoiceRow {
  kind: "option" | "custom";
  optionIndex?: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  // Bracketed paste is already normalized by ProcessTerminal. Keep printable
  // text (including CJK and pasted line breaks) while excluding raw terminal
  // control input. safeSheetText() normalizes the allowed whitespace below.
  // eslint-disable-next-line no-control-regex
  return data && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(data) ? data : undefined;
}

function removeLastGrapheme(value: string): string {
  const segments = [...graphemeSegmenter.segment(value)];
  const last = segments[segments.length - 1];
  return last ? value.slice(0, last.index) : "";
}

function joinColumns(left: string, right: string, width: number, theme = darkTheme): string {
  if (!right || width < 56) {
    const combined = right ? `${left}  ${themeDim(theme.dim, right)}` : left;
    return truncateToWidth(combined, width, "…");
  }
  // The reference keeps the answer label compact and gives the explanation
  // most of the row. At a 100-column terminal the second column begins around
  // column 33, rather than drifting toward the middle of the sheet.
  const leftWidth = Math.max(20, Math.min(34, Math.floor(width * 0.33)));
  const renderedLeft = truncateToWidth(left, leftWidth - 2, "…");
  const gap = " ".repeat(Math.max(2, leftWidth - visibleWidth(renderedLeft)));
  return `${renderedLeft}${gap}${themeDim(theme.dim, truncateToWidth(right, Math.max(1, width - leftWidth), "…"))}`;
}

/** Request-aware, bottom-docked replacement for the lost Ink QuestionDialog. */
export class QuestionDialogComponent implements Component, Focusable {
  focused = false;
  private questionIndex = 0;
  private selectedIndex = 0;
  private customInput = "";
  private answers: QuestionAnswer[];

  onSubmit?: (answers: QuestionAnswer[]) => void;
  onCancel?: () => void;

  constructor(
    private readonly request: QuestionRequest,
    private readonly getTerminalRows: () => number,
    private readonly getTheme: () => Theme = () => darkTheme,
  ) {
    this.answers = request.questions.map(() => []);
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.getTerminalRows());
    // A bottom sheet must not become the entire screen after a resize. Keep
    // one transcript row visible whenever the terminal has room for it.
    const sheetRows = terminalRows > 1 ? terminalRows - 1 : 1;
    const question = this.currentQuestion();
    if (!question) return [];
    const canUseCustom = question.custom !== false;
    const rows: ChoiceRow[] = [
      ...question.options.map((_, optionIndex) => ({ kind: "option" as const, optionIndex })),
      ...(canUseCustom ? [{ kind: "custom" as const }] : []),
    ];
    const showOuterHelp = sheetRows >= 5;
    const available = Math.max(1, sheetRows - (showOuterHelp ? 1 : 0));
    const roomy = available >= 8;
    const showInnerHelp = available >= 5;
    const fixedRows = 1 + (roomy ? 3 : 0) + (showInnerHelp ? 1 : 0);
    const choiceBudget = Math.max(0, Math.min(rows.length, available - fixedRows));
    const panelBudget = fixedRows + choiceBudget;
    const indentWidth = safeWidth >= 12 ? 2 : safeWidth >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, safeWidth - indentWidth * 2);
    const selectedStart = Math.max(
      0,
      Math.min(this.selectedIndex - choiceBudget + 1, Math.max(0, rows.length - choiceBudget)),
    );
    const visibleRows = rows.slice(selectedStart, selectedStart + choiceBudget);
    const panel: Array<{ line: string; selected?: boolean }> = [];

    if (roomy) panel.push({ line: "" });
    const tab = this.request.questions.length > 1
      ? themeDim(theme.dim, `  ${safeSheetInlineText(question.header) || "Question"} ${this.questionIndex + 1}/${this.request.questions.length}`)
      : "";
    const titleWidth = Math.max(1, contentWidth - visibleWidth(tab));
    panel.push({
      line: `${indent}${chalk.bold(themeForeground(theme.inputText, truncateToWidth(safeSheetInlineText(question.question), titleWidth, "…")))}${tab}`,
    });
    if (roomy) panel.push({ line: "" });

    const currentAnswers = this.answers[this.questionIndex] ?? [];
    for (const row of visibleRows) {
      const absoluteIndex = rows.indexOf(row);
      const selected = absoluteIndex === this.selectedIndex;
      if (row.kind === "custom") {
        const marker = this.customInput.trim() ? "●" : "○";
        const custom = this.customInput || "Type your answer here";
        panel.push({
          line: `${indent}${selected
            ? chalk.bold(themeForeground(theme.inputText, `z (${marker}) ${custom}`))
            : themeForeground(theme.muted, `z (${marker}) ${custom}`)}`,
          selected,
        });
        continue;
      }
      const optionIndex = row.optionIndex ?? 0;
      const option = question.options[optionIndex]!;
      const checked = currentAnswers.includes(option.label);
      const marker = checked ? "●" : "○";
      const left = `${optionIndex + 1} (${marker}) ${safeSheetInlineText(option.label)}`;
      const line = joinColumns(left, safeSheetInlineText(option.description), contentWidth, theme);
      panel.push({
        line: `${indent}${selected
          ? chalk.bold(themeForeground(theme.inputText, line))
          : themeForeground(theme.muted, line)}`,
        selected,
      });
    }

    if (roomy) panel.push({ line: "" });
    if (showInnerHelp) {
      const selectionHelp = question.multiple ? "↑/↓ navigate · Space toggle · type custom" : "↑/↓ navigate · type custom";
      const submitHelp = this.questionIndex < this.request.questions.length - 1 ? "Enter:next" : "Enter:submit";
      const rightGap = Math.max(1, contentWidth - visibleWidth(selectionHelp) - visibleWidth(submitHelp));
      panel.push({
        line: `${indent}${themeDim(theme.dim, truncateToWidth(`${selectionHelp}${" ".repeat(rightGap)}${submitHelp}`, contentWidth, ""))}`,
      });
    }
    const painted = panel.slice(0, panelBudget).map(({ line, selected }) => paintSheetLine(line, safeWidth, selected, theme));
    if (!showOuterHelp) return painted;
    const outerHelp = this.request.questions.length > 1
      ? "Tab next question  │  ←/→ change question  │  Esc dismiss"
      : "Tab next answer  │  Esc dismiss  │  Shift+X dismiss";
    return [...painted, themeDim(theme.dim, padSheetLine(outerHelp, safeWidth))];
  }

  handleInput(data: string): void {
    const question = this.currentQuestion();
    if (!question) return;
    const rowCount = question.options.length + (question.custom === false ? 0 : 1);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "shift+x")) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selectedIndex = (this.selectedIndex + rowCount - 1) % Math.max(1, rowCount);
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, rowCount);
      return;
    }
    if (matchesKey(data, "left") && this.questionIndex > 0) {
      this.saveCurrentAnswer();
      this.moveToQuestion(this.questionIndex - 1);
      return;
    }
    if (matchesKey(data, "right") && this.questionIndex < this.request.questions.length - 1) {
      this.saveCurrentAnswer();
      this.moveToQuestion(this.questionIndex + 1);
      return;
    }
    if (matchesKey(data, "tab")) {
      if (this.request.questions.length > 1) {
        this.commitAndAdvance();
      } else {
        this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, rowCount);
      }
      return;
    }
    if (/^[1-9]$/.test(data) && Number(data) <= question.options.length) {
      this.selectedIndex = Number(data) - 1;
      return;
    }
    const customSelected = question.custom !== false && this.selectedIndex === question.options.length;
    if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      if (customSelected) this.customInput = removeLastGrapheme(this.customInput);
      return;
    }
    if (data === " " && !customSelected) {
      this.toggleSelectedOption();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.commitAndAdvance();
      return;
    }
    const printable = printableInput(data);
    if (printable !== undefined && question.custom !== false) {
      this.selectedIndex = question.options.length;
      this.customInput += safeSheetText(printable).replace(/\n/g, " ");
    }
  }

  invalidate(): void {
    // Width, height, selection, and answers are projected on every render.
  }

  private currentQuestion() {
    return this.request.questions[this.questionIndex];
  }

  private saveCurrentAnswer(): QuestionAnswer {
    const question = this.currentQuestion();
    if (!question) return [];
    const customSelected = question.custom !== false && this.selectedIndex === question.options.length;
    let answer: QuestionAnswer;
    if (customSelected) {
      answer = this.customInput.trim() ? [this.customInput.trim()] : [];
    } else if (question.multiple) {
      answer = [...(this.answers[this.questionIndex] ?? [])];
    } else {
      const label = question.options[this.selectedIndex]?.label;
      answer = label ? [label] : [];
    }
    this.answers[this.questionIndex] = answer;
    return answer;
  }

  private toggleSelectedOption(): void {
    const question = this.currentQuestion();
    const option = question?.options[this.selectedIndex]?.label;
    if (!question || !option) return;
    if (!question.multiple) {
      this.answers[this.questionIndex] = [option];
      return;
    }
    const current = this.answers[this.questionIndex] ?? [];
    this.answers[this.questionIndex] = current.includes(option)
      ? current.filter((item) => item !== option)
      : [...current, option];
  }

  private commitAndAdvance(): void {
    this.saveCurrentAnswer();
    if (this.questionIndex < this.request.questions.length - 1) {
      this.moveToQuestion(this.questionIndex + 1);
      return;
    }
    this.onSubmit?.(this.answers.map((answer) => [...answer]));
  }

  private moveToQuestion(index: number): void {
    this.questionIndex = index;
    const question = this.currentQuestion();
    const prior = this.answers[index]?.[0];
    const priorOption = question?.options.findIndex((option) => option.label === prior) ?? -1;
    if (priorOption >= 0) {
      this.selectedIndex = priorOption;
      this.customInput = "";
    } else if (prior && question?.custom !== false) {
      this.selectedIndex = question.options.length;
      this.customInput = prior;
    } else {
      this.selectedIndex = 0;
      this.customInput = "";
    }
  }
}
