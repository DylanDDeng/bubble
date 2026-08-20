import path from "node:path";
import chalk from "chalk";
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@bubblebrain-ai/pi-tui";
import type { ApprovalRequest } from "../../approval/types.js";

export type ApprovalDialogChoice = "approve_once" | "approve_always" | "reject";

interface ApprovalPresentation {
  title: string;
  details: string[];
}

const PANEL_BACKGROUND = "#242424";
const SELECTED_BACKGROUND = "#3A3A3A";

const CHOICES: ReadonlyArray<{ value: ApprovalDialogChoice; label: string }> = [
  { value: "approve_once", label: "Yes, proceed" },
  { value: "approve_always", label: "Yes, don't ask again (switch to Bypass Permissions)" },
  { value: "reject", label: "No, reject" },
];

function safeTerminalText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    // Keep user-visible newlines, but never let request data inject cursor,
    // OSC, APC, bell, or other terminal control behavior into the approval UI.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

function bashCommandLabel(command: string): string {
  const firstToken = safeTerminalText(command).trim().match(/^([^\s;&|]+)/)?.[1] ?? "command";
  const unquoted = firstToken.replace(/^["'`]+|["'`]+$/g, "");
  return path.basename(unquoted) || "command";
}

function jsonPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return safeTerminalText(JSON.stringify(value));
  } catch {
    return safeTerminalText(String(value));
  }
}

/** Convert every approval variant into a compact, request-specific heading and preview. */
export function approvalPresentation(request: ApprovalRequest): ApprovalPresentation {
  switch (request.type) {
    case "bash":
      return {
        title: `Request approval for ${bashCommandLabel(request.command)}`,
        details: [
          safeTerminalText(request.command),
          `${request.background ? "background command" : "working directory"}: ${safeTerminalText(request.cwd)}`,
        ],
      };
    case "edit":
      return {
        title: safeTerminalText(`Request approval to edit ${path.basename(request.path) || request.path}`),
        details: [request.path, ...request.diff.split("\n").filter(Boolean).slice(0, 2)].map(safeTerminalText),
      };
    case "write":
      return {
        title: safeTerminalText(`Request approval to ${request.fileExists ? "overwrite" : "create"} ${path.basename(request.path) || request.path}`),
        details: [request.path, ...(request.diff ?? request.content).split("\n").filter(Boolean).slice(0, 2)].map(safeTerminalText),
      };
    case "patch":
      return {
        title: `Request approval to update ${request.files.length} file${request.files.length === 1 ? "" : "s"}`,
        details: (request.paths.length > 0 ? request.paths : [request.path]).map(safeTerminalText),
      };
    case "lsp":
      return {
        title: safeTerminalText(`Request approval for ${request.operation}`),
        details: [safeTerminalText(request.path)],
      };
    case "agent_profile":
      return {
        title: safeTerminalText(`Trust agent profile ${request.name}`),
        details: [request.path, ...request.promptPreview.split("\n").filter(Boolean).slice(0, 2)].map(safeTerminalText),
      };
    case "external_tool": {
      const input = jsonPreview(request.rawInput);
      const locations = request.locations?.map((location) =>
        location.line == null ? location.path : `${location.path}:${location.line}`,
      ) ?? [];
      return {
        title: safeTerminalText(`Request approval for ${request.title.trim() || request.kind.trim() || "external tool"}`),
        details: [...(input ? [input] : []), ...locations].map(safeTerminalText),
      };
    }
  }
}

function padToWidth(line: string, width: number): string {
  const truncated = truncateToWidth(line, Math.max(1, width), "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function styleDetail(request: ApprovalRequest, detail: string, index: number): string {
  if (request.type === "bash" && index === 0) {
    const commandMatch = detail.match(/^(\S+)([\s\S]*)$/);
    if (commandMatch) {
      return chalk.cyan(commandMatch[1]) + chalk.green(commandMatch[2]);
    }
  }
  return index === 0 ? chalk.cyan(detail) : chalk.dim(detail);
}

/**
 * Bottom-docked approval sheet inspired by coding-agent permission cards.
 * It owns selection and shortcuts so global run-cancellation cannot steal
 * Escape/Ctrl+C while the tool call is waiting for a decision.
 */
export class ApprovalDialogComponent implements Component, Focusable {
  focused = false;
  private selectedIndex = 0;

  onSelect?: (choice: ApprovalDialogChoice) => void;
  onCancel?: () => void;

  constructor(
    private readonly request: ApprovalRequest,
    private readonly getTerminalRows: () => number,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.getTerminalRows());
    const showHelp = terminalRows >= 5;
    const panelBudget = Math.max(1, Math.min(9, terminalRows - (showHelp ? 1 : 0)));
    const presentation = approvalPresentation(this.request);
    const choiceCount = Math.min(CHOICES.length, panelBudget);
    const extraRows = Math.max(0, panelBudget - choiceCount);
    const contentWidth = Math.max(1, safeWidth - (safeWidth >= 12 ? 4 : 2));
    const indent = " ".repeat(safeWidth >= 12 ? 2 : 1);

    let remainingExtras = extraRows;
    const topPadding = remainingExtras >= 5 ? 1 : 0;
    remainingExtras -= topPadding;
    const titleRows = remainingExtras > 0 ? 1 : 0;
    remainingExtras -= titleRows;
    const bottomPadding = remainingExtras >= 4 ? 1 : 0;
    remainingExtras -= bottomPadding;
    const blankBeforeChoices = remainingExtras >= 2 ? 1 : 0;
    remainingExtras -= blankBeforeChoices;
    const detailBudget = remainingExtras;

    const panelLines: Array<{ line: string; selected?: boolean }> = [];
    if (topPadding) panelLines.push({ line: "" });
    if (titleRows) {
      panelLines.push({ line: `${indent}${chalk.bold.white(truncateToWidth(presentation.title, contentWidth, "…"))}` });
    }

    if (detailBudget > 0) {
      const renderedDetails: string[] = [];
      for (let index = 0; index < presentation.details.length && renderedDetails.length < detailBudget; index += 1) {
        const detail = presentation.details[index];
        if (!detail) continue;
        const styled = styleDetail(this.request, detail, index);
        renderedDetails.push(...wrapTextWithAnsi(styled, contentWidth));
      }
      for (const detail of renderedDetails.slice(0, detailBudget)) {
        panelLines.push({ line: `${indent}${detail}` });
      }
      while (panelLines.length < topPadding + titleRows + detailBudget) panelLines.push({ line: "" });
    }
    if (blankBeforeChoices) panelLines.push({ line: "" });

    const visibleChoices = choiceCount === CHOICES.length
      ? CHOICES.map((choice, index) => ({ choice, index }))
      : CHOICES
          .map((choice, index) => ({ choice, index }))
          .slice(Math.max(0, Math.min(this.selectedIndex - choiceCount + 1, CHOICES.length - choiceCount)), CHOICES.length)
          .slice(0, choiceCount);

    for (const { choice, index } of visibleChoices) {
      const selected = index === this.selectedIndex;
      const radio = selected ? "●" : "○";
      const label = `${index + 1} (${radio}) ${choice.label}`;
      const line = `${indent}${selected ? chalk.bold.white(label) : chalk.gray(label)}`;
      panelLines.push({ line, selected });
    }
    if (bottomPadding) panelLines.push({ line: "" });

    const paintedPanel = panelLines.slice(0, panelBudget).map(({ line, selected }) =>
      chalk.bgHex(selected ? SELECTED_BACKGROUND : PANEL_BACKGROUND)(padToWidth(line, safeWidth)),
    );

    if (!showHelp) return paintedPanel;
    const help = `${this.selectedIndex + 1}/${CHOICES.length} select  │  Tab next  │  Enter confirm  │  Ctrl+O bypass  │  Esc deny`;
    return [...paintedPanel, chalk.dim(padToWidth(help, safeWidth))];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
      this.selectedIndex = (this.selectedIndex + CHOICES.length - 1) % CHOICES.length;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.selectedIndex = (this.selectedIndex + 1) % CHOICES.length;
      return;
    }
    if (data === "1" || data === "2" || data === "3") {
      this.selectedIndex = Number(data) - 1;
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      this.onSelect?.("approve_always");
      return;
    }
    if (matchesKey(data, "enter")) {
      this.onSelect?.(CHOICES[this.selectedIndex]!.value);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancel?.();
    }
  }

  invalidate(): void {
    // Rendering is derived from current width, height, request, and selection.
  }
}
