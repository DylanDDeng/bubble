/**
 * Streaming assistant message component.
 *
 * Rendering contract (verified against the vendored TuiMainScreen with
 * VirtualTerminal): rebuilding component children every frame makes the
 * renderer treat old rows as deleted and commits every intermediate frame
 * to scrollback (the duplicated-prefix bug). A pool of PERSISTENT Text
 * components updated via setText() is rewritten in place and never leaks —
 * and Text("") renders zero rows, so empty pool slots vanish from the
 * document naturally.
 *
 * Lifecycle: append one instance as the transcript container's LAST child
 * when a turn starts, update() per flush, and clearToNothing() in the same
 * frame the controller commits the settled message (all slots setText(""),
 * component collapses to zero rows; the full answer arrives via the normal
 * transcript append).
 */
import chalk from "chalk";
import { Spacer, Text, truncateToWidth, VStack } from "@bubblebrain-ai/pi-tui";
import type { DisplayMessagePart, DisplayToolCall } from "../model/display-history.js";
import { renderToolTraceGroups, wrapPlain } from "./transcript.js";

export interface StreamingTailState {
  content: string;
  reasoning: string;
  tools: readonly DisplayToolCall[];
  parts: readonly DisplayMessagePart[];
  phase?: "thinking" | "working";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GENERIC_PHRASES = [
  "mapping the workspace",
  "reading the room",
  "following the threads",
  "connecting the pieces",
  "sorting the context",
  "scanning the structure",
  "shaping the next step",
  "gathering signal",
  "checking the edges",
  "lining up the answer",
  "tracing the flow",
  "building the picture",
  "walking the graph",
  "collecting the clues",
  "framing the problem",
  "locating the source",
  "resolving the shape",
  "untangling the state",
  "comparing the paths",
  "narrowing the target",
  "tracking the changes",
  "reading the patterns",
  "weighing the options",
  "assembling the context",
  "following the signal",
  "checking the assumptions",
  "aligning the details",
  "testing the shape",
  "pulling the thread",
  "cleaning the edges",
  "refining the draft",
  "verifying the route",
  "making sense of it",
  "looking for leverage",
  "stitching the answer",
  "holding the thread",
  "distilling the noise",
  "finding the seam",
  "reading between the lines",
  "preparing the response",
] as const;

const TOOL_TARGET_PHRASES: Record<string, string> = {
  read: "reading files",
  write: "writing changes",
  edit: "patching files",
  grep: "searching the codebase",
  glob: "scanning paths",
  ls: "listing directories",
  bash: "running command",
  web_search: "searching the web",
  web_fetch: "fetching a page",
  task: "spawning subagent",
  spawn_agent: "spawning subagent",
  run_workflow: "running workflow",
  wait_agent: "waiting for subagent",
  wait_workflow: "waiting for workflow",
};

function approximateTokenLabel(chars: number): string {
  const tokens = Math.max(0, Math.round(chars / 4));
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

export class StreamingMessageComponent extends VStack {
  private tail: StreamingTailState | null = null;
  private frame = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onFrame?: () => void;

  // Persistent row pool — NEVER re-created, only setText.
  private readonly topGapRow: Spacer;
  private readonly thinkingHeaderRow: Text;
  private readonly statusRow: Text;
  private readonly thinkingEllipsisRow: Text;
  private readonly timelineEllipsisRow: Text;
  private readonly liveGapRow: Spacer;
  private readonly reasoningRows: Text[];
  private readonly timelineRows: Text[];
  private idlePhraseIndex = 0;
  private phraseTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxPreviewRows = 8, onFrame?: () => void) {
    super([]);
    this.onFrame = onFrame;
    this.topGapRow = new Spacer(0);
    this.thinkingHeaderRow = new Text("", 0, 0);
    this.statusRow = new Text("", 0, 0);
    this.thinkingEllipsisRow = new Text("", 0, 0);
    this.timelineEllipsisRow = new Text("", 0, 0);
    this.liveGapRow = new Spacer(0);
    this.reasoningRows = Array.from({ length: 5 }, () => new Text("", 0, 0));
    // One ordered pool mirrors Ink's DisplayMessagePart timeline. Reserve
    // enough rows for a useful grouped tool trace plus an answer tail.
    this.timelineRows = Array.from({ length: maxPreviewRows + 16 }, () => new Text("", 0, 0));
    // Ink cadence: live tail first, spinner below it, then composer/footer.
    this.addChild(this.topGapRow);
    this.addChild(this.thinkingHeaderRow);
    for (const row of this.reasoningRows) this.addChild(row);
    this.addChild(this.thinkingEllipsisRow);
    this.addChild(this.timelineEllipsisRow);
    for (const row of this.timelineRows) this.addChild(row);
    this.addChild(this.liveGapRow);
    this.addChild(this.statusRow);
  }

  /** Live update while streaming. */
  update(tail: StreamingTailState, columns: number): void {
    this.tail = tail;
    this.lastColumns = columns;
    const width = Math.max(1, Math.floor(columns));
    const idlePhrase = GENERIC_PHRASES[this.idlePhraseIndex % GENERIC_PHRASES.length]!;
    const activeTool = [...tail.tools].reverse().find((tool) => (
      tool.status === "queued"
      || tool.status === "pending"
      || tool.status === "running"
      || (tool.status === undefined && tool.result === undefined)
    ));
    const phrase = activeTool
      ? TOOL_TARGET_PHRASES[activeTool.name] ?? `running ${activeTool.name}`
      : tail.content
        ? "writing the response"
        : tail.reasoning
          ? "working through the request"
          : idlePhrase;
    const streamedChars = tail.content.length + tail.reasoning.length;
    const tokenText = streamedChars > 0 ? ` (↓${approximateTokenLabel(streamedChars)} tok)` : "";
    this.statusRow.setText(truncateToWidth(
      ` ${chalk.cyan(SPINNER_FRAMES[this.frame]!)} ${chalk.dim(`${phrase}${tokenText}`)}`,
      width,
    ));
    // A stable unpainted row separates the sent card from all live activity.
    this.topGapRow.setLines(1);

    let hasLiveRows = false;
    this.thinkingHeaderRow.setText("");
    this.thinkingEllipsisRow.setText("");
    this.timelineEllipsisRow.setText("");
    for (const row of this.reasoningRows) row.setText("");
    for (const row of this.timelineRows) row.setText("");
    // Reasoning models get a dedicated rolling window instead of burying
    // their work inside the spinner status line. It is an independent region:
    // answer/tool bytes must not make Thinking disappear mid-frame.
    if (tail.reasoning) {
      hasLiveRows = true;
      this.thinkingHeaderRow.setText(truncateToWidth(chalk.dim("  ✻ Thinking…"), width));
      const reasoningLines = tail.reasoning.split("\n").filter((line) => line.trim() !== "");
      const visible = reasoningLines.slice(-this.reasoningRows.length);
      for (let index = 0; index < visible.length; index += 1) {
        this.reasoningRows[index]!.setText(truncateToWidth(chalk.dim(`  ${visible[index]}`), width));
      }
      if (reasoningLines.length > visible.length) this.thinkingEllipsisRow.setText(chalk.dim("  …"));
    }

    const parts: readonly DisplayMessagePart[] = tail.parts.length > 0
      ? tail.parts
      : [
          ...(tail.tools.length > 0 ? [{ type: "tools" as const, toolCalls: [...tail.tools] }] : []),
          ...(tail.content ? [{ type: "text" as const, content: tail.content }] : []),
        ];
    let lastToolsPart = -1;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index]?.type === "tools") {
        lastToolsPart = index;
        break;
      }
    }
    const timeline: string[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]!;
      if (part.type === "tools") {
        timeline.push(...renderToolTraceGroups(
          part.toolCalls,
          { columns: width },
          { showActivity: partIndex === lastToolsPart },
        ));
        continue;
      }
      const lines = wrapPlain(part.content, Math.max(1, width - 4));
      for (let index = 0; index < lines.length; index += 1) {
        timeline.push(`${index === 0 ? "  ● " : "    "}${lines[index] ?? ""}`);
      }
    }
    if (timeline.length > 0) {
      hasLiveRows = true;
      const visible = timeline.slice(-this.timelineRows.length);
      this.timelineEllipsisRow.setText(timeline.length > visible.length ? chalk.dim("  …") : "");
      for (let index = 0; index < visible.length; index += 1) {
        this.timelineRows[index]!.setText(truncateToWidth(visible[index]!, width));
      }
    }
    this.liveGapRow.setLines(hasLiveRows ? 1 : 0);
  }

  /**
   * Turn ended: collapse every slot. Same-frame with the controller's
   * settled append so the full answer replaces the preview without a
   * duplicated or stale frame.
   */
  clearToNothing(): void {
    this.stopSpinner();
    this.tail = null;
    this.topGapRow.setLines(0);
    this.thinkingHeaderRow.setText("");
    this.statusRow.setText("");
    this.thinkingEllipsisRow.setText("");
    this.timelineEllipsisRow.setText("");
    this.liveGapRow.setLines(0);
    for (const row of this.reasoningRows) row.setText("");
    for (const row of this.timelineRows) row.setText("");
  }

  startSpinner(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      if (this.tail) {
        // Re-render just the glyph by re-running the status text build.
        const keep = this.tail;
        this.update(keep, this.lastColumns ?? 80);
      }
      this.onFrame?.();
    }, 100);
    this.phraseTimer = setInterval(() => {
      if (!this.tail || this.tail.content || this.tail.reasoning || this.tail.tools.length > 0) return;
      this.idlePhraseIndex = (this.idlePhraseIndex + 1) % GENERIC_PHRASES.length;
      this.update(this.tail, this.lastColumns ?? 80);
      this.onFrame?.();
    }, 1_500);
  }

  private lastColumns?: number;

  stopSpinner(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.phraseTimer) {
      clearInterval(this.phraseTimer);
      this.phraseTimer = null;
    }
  }

  dispose(): void {
    this.stopSpinner();
  }

  /** Remember the width for spinner-driven rebuilds between flushes. */
  noteWidth(columns: number): void {
    this.lastColumns = columns;
  }
}
