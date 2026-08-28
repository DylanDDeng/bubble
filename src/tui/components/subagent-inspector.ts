import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@bubblebrain-ai/pi-tui";
import type { BubbleTuiController } from "../controller/controller.js";
import type { TranscriptRenderOptions } from "./transcript.js";
import {
  joinTranscriptBlocks,
  projectAssistantRows,
  projectReasoningRows,
  projectToolTraceGroups,
  projectTranscript,
} from "./transcript.js";
import type { SubagentDisplay } from "../model/subagent-view.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";

export interface SubagentInspectorOptions {
  agentId: string;
  controller: BubbleTuiController;
  getMember(): SubagentDisplay | undefined;
  getTerminalRows(): number;
  renderOptions(): Omit<TranscriptRenderOptions, "columns">;
  onClose(): void;
  onNavigate?(direction: -1 | 1): void;
  onRender(): void;
  theme?: Theme;
}

function pad(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(1, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function tokens(member: SubagentDisplay | undefined): string {
  if (!member?.usage) return "";
  const total = member.usage.promptTokens + member.usage.completionTokens;
  return total >= 1000 ? `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k tok` : `${total} tok`;
}

function elapsed(member: SubagentDisplay | undefined): string {
  if (!member?.createdAt) return "";
  const final = new Set(["completed", "failed", "blocked", "cancelled", "closed"]).has(member.status ?? "");
  const seconds = Math.floor((((final ? member.updatedAt : Date.now()) ?? Date.now()) - member.createdAt) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export class SubagentInspectorComponent implements Component {
  focused = false;
  private scrollOffset = 0;
  private followEnd = true;
  private lastBodyRows = 0;
  private lastContentRows = 0;

  constructor(private readonly options: SubagentInspectorOptions) {}

  render(width: number): string[] {
    const theme = this.options.theme ?? darkTheme;
    const frameWidth = Math.max(1, Math.floor(width));
    const bodyWidth = Math.max(1, frameWidth - 4);
    const member = this.options.getMember();
    const transcript = projectTranscript(this.options.controller.getChildTranscript(this.options.agentId), {
      ...this.options.renderOptions(),
      columns: bodyWidth,
      trailingSpacer: false,
    }).rows;
    const tail = this.options.controller.getChildStreamingTail(this.options.agentId);
    const liveRows = tail
      ? joinTranscriptBlocks([
          tail.reasoning ? projectReasoningRows(tail.reasoning, { ...this.options.renderOptions(), columns: bodyWidth }, { running: true }) : [],
          tail.tools.length > 0 ? projectToolTraceGroups(tail.tools, { ...this.options.renderOptions(), columns: bodyWidth }, { showActivity: true }).rows : [],
          tail.content ? projectAssistantRows(tail.content, { ...this.options.renderOptions(), columns: bodyWidth }) : [],
        ])
      : [];
    const content = joinTranscriptBlocks([transcript, liveRows]);
    const terminalRows = Math.max(8, this.options.getTerminalRows());
    const bodyRows = Math.max(3, terminalRows - 6);
    this.lastBodyRows = bodyRows;
    this.lastContentRows = content.length;
    const maxOffset = Math.max(0, content.length - bodyRows);
    if (this.followEnd) this.scrollOffset = maxOffset;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const visible = content.slice(this.scrollOffset, this.scrollOffset + bodyRows);
    while (visible.length < bodyRows) visible.push("");

    const status = member?.status ?? "running";
    const route = member?.route?.model ?? member?.agentName ?? "subagent";
    const meta = [status, route, tokens(member), elapsed(member)].filter(Boolean).join(" · ");
    const title = `${member?.nickname ?? member?.agentName ?? "Subagent"} — read only`;
    if (frameWidth < 6) {
      return [title, meta, ...visible]
        .slice(0, Math.max(1, this.options.getTerminalRows()))
        .map((row) => truncateToWidth(row, frameWidth, ""));
    }
    const border = (text: string) => themeForeground(theme.border, text);
    const top = border(`┌─ ${truncateToWidth(title, Math.max(1, frameWidth - 6), "")} ${"─".repeat(Math.max(0, frameWidth - visibleWidth(title) - 5))}┐`);
    const header = `${border("│")} ${pad(themeDim(theme.dim, meta), bodyWidth)} ${border("│")}`;
    const separator = border(`├${"─".repeat(frameWidth - 2)}┤`);
    const body = visible.map((row) => `${border("│")} ${pad(row, bodyWidth)} ${border("│")}`);
    const hint = pad(themeDim(theme.dim, "↑↓ scroll · [ ] previous/next · x stop · Esc close"), bodyWidth);
    const bottom = border(`└${"─".repeat(frameWidth - 2)}┘`);
    return [top, header, separator, ...body, `${border("│")} ${hint} ${border("│")}`, bottom];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.options.onClose();
      return;
    }
    if (data === "x") {
      const status = this.options.getMember()?.status ?? "running";
      if (!new Set(["completed", "failed", "blocked", "cancelled", "closed"]).has(status)) {
        this.options.controller.stopSubagent(this.options.agentId);
      }
      return;
    }
    if (data === "[") {
      this.options.onNavigate?.(-1);
      return;
    }
    if (data === "]") {
      this.options.onNavigate?.(1);
      return;
    }
    const maxOffset = Math.max(0, this.lastContentRows - this.lastBodyRows);
    if (matchesKey(data, "up") || data === "k") {
      this.followEnd = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
      this.followEnd = this.scrollOffset >= maxOffset;
    } else if (matchesKey(data, "pageUp")) {
      this.followEnd = false;
      this.scrollOffset = Math.max(0, this.scrollOffset - this.lastBodyRows);
    } else if (matchesKey(data, "pageDown")) {
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.lastBodyRows);
      this.followEnd = this.scrollOffset >= maxOffset;
    } else if (matchesKey(data, "end")) {
      this.followEnd = true;
      this.scrollOffset = maxOffset;
    } else {
      return;
    }
    this.options.onRender();
  }

  invalidate(): void {}
}
