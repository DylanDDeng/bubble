import chalk from "chalk";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@bubblebrain-ai/pi-tui";

export const BOTTOM_SHEET_BACKGROUND = "#242424";
export const BOTTOM_SHEET_SELECTED_BACKGROUND = "#3A3A3A";

/** Treat model/tool supplied copy as text, never as terminal instructions. */
export function safeSheetText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    // Preserve visible newlines but neutralize every other control character.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

export function padSheetLine(line: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const truncated = truncateToWidth(line, safeWidth, "");
  return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
}

export function paintSheetLine(line: string, width: number, selected = false): string {
  return chalk
    .bgHex(selected ? BOTTOM_SHEET_SELECTED_BACKGROUND : BOTTOM_SHEET_BACKGROUND)
    (padSheetLine(line, width));
}
