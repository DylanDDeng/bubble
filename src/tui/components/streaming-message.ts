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
 * Lifecycle: keep one instance as the transcript container's LAST child,
 * update() per flush, and clearToNothing() in the same frame the controller
 * commits the settled message. The scrollable row pool collapses to zero;
 * the separate activityLane stays one row tall and merely clears its text.
 */
import chalk from "chalk";
import {
  Spacer,
  Text,
  truncateToWidth,
  VStack,
  type Component,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { DisplayMessagePart, DisplayToolCall } from "../model/display-history.js";
import type { TraceInteractionState, TraceRowTarget } from "../model/trace-interaction.js";
import {
  projectAssistantRows,
  projectReasoningRows,
  joinTranscriptProjections,
  MINIMAL_REASONING_BODY_ROWS,
  projectToolTraceGroups,
  type TranscriptProjection,
  type TranscriptRenderOptions,
} from "./transcript.js";

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

/**
 * A permanent one-row boundary between the scrolling transcript and composer.
 * Running turns paint the spinner into this lane; idle turns leave it blank.
 * The row never collapses, so completing a turn cannot change the document /
 * composer geometry.
 */
export class AgentActivityLaneComponent implements Component {
  private text = "";

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, Math.floor(width)))];
  }

  invalidate(): void {
    // No cache: the owner mutates `text` and requests the enclosing TUI render.
  }
}

/**
 * A pooled projected row needs three states: unused (zero rows), semantic
 * blank (one empty row), and visible text. `Text` collapses both unused and
 * whitespace-only values, so it cannot preserve that distinction.
 */
class ProjectedRowComponent implements Component {
  private row: string | null = null;
  private target?: TraceRowTarget;
  private interaction?: TraceInteractionState;

  constructor(private readonly onActivate?: () => void) {}

  setRow(row: string, target?: TraceRowTarget, interaction?: TraceInteractionState): void {
    this.row = row;
    this.target = target;
    this.interaction = interaction;
  }

  clear(): void {
    this.row = null;
    this.target = undefined;
    this.interaction = undefined;
  }

  render(width: number): string[] {
    if (this.row === null) return [];
    if (this.row === "") return [""];
    return [truncateToWidth(this.row, Math.max(1, Math.floor(width)))];
  }

  invalidate(): void {
    // No cache; rows are already projected to terminal lines.
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (!this.interaction) return false;
    if (event.kind === "leave") {
      const changed = this.interaction.clearHover();
      if (changed) this.onActivate?.();
      return changed;
    }
    if (event.kind === "move") {
      const changed = this.interaction.hover(this.target);
      if (changed) this.onActivate?.();
      return changed;
    }
    if (event.release || (event.button & 3) !== 0 || !this.target) return false;
    this.interaction.activate(this.target, event.clickCount);
    this.onActivate?.();
    return true;
  }
}

export class StreamingMessageComponent extends VStack {
  private tail: StreamingTailState | null = null;
  private frame = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onFrame?: () => void;

  // Persistent row pool — NEVER re-created, only setText.
  readonly activityLane: AgentActivityLaneComponent;
  private readonly thinkingHeaderRow: Text;
  private readonly thinkingEllipsisRow: Text;
  private readonly reasoningGapRow: Spacer;
  private readonly timelineEllipsisRow: Text;
  private readonly liveGapRow: Spacer;
  private readonly reasoningRows: Text[];
  private readonly timelineRows: ProjectedRowComponent[];
  private idlePhraseIndex = 0;
  private phraseTimer: ReturnType<typeof setInterval> | null = null;
  private projectionOptions: Omit<TranscriptRenderOptions, "columns"> = {};

  constructor(maxPreviewRows = 8, onFrame?: () => void) {
    super([]);
    this.onFrame = onFrame;
    this.activityLane = new AgentActivityLaneComponent();
    this.thinkingHeaderRow = new Text("", 0, 0);
    this.thinkingEllipsisRow = new Text("", 0, 0);
    this.reasoningGapRow = new Spacer(0);
    this.timelineEllipsisRow = new Text("", 0, 0);
    this.liveGapRow = new Spacer(0);
    this.reasoningRows = Array.from({ length: MINIMAL_REASONING_BODY_ROWS }, () => new Text("", 0, 0));
    // One ordered pool mirrors Ink's DisplayMessagePart timeline. Reserve
    // enough rows for a useful grouped tool trace plus an answer tail.
    this.timelineRows = Array.from(
      { length: maxPreviewRows + 16 },
      () => new ProjectedRowComponent(() => {
        if (this.tail) this.update(this.tail, this.lastColumns ?? 80, this.projectionOptions);
        this.onFrame?.();
      }),
    );
    // The live tail remains scrollable. Its spinner lives in the permanent
    // activity lane mounted by the app immediately above the composer.
    this.addChild(this.thinkingHeaderRow);
    for (const row of this.reasoningRows) this.addChild(row);
    this.addChild(this.thinkingEllipsisRow);
    this.addChild(this.reasoningGapRow);
    this.addChild(this.timelineEllipsisRow);
    for (const row of this.timelineRows) this.addChild(row);
    this.addChild(this.liveGapRow);
  }

  /** Live update while streaming. */
  update(
    tail: StreamingTailState,
    columns: number,
    projectionOptions: Omit<TranscriptRenderOptions, "columns"> = {},
  ): void {
    this.tail = tail;
    this.lastColumns = columns;
    this.projectionOptions = projectionOptions;
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
    this.activityLane.setText(truncateToWidth(
      ` ${chalk.cyan(SPINNER_FRAMES[this.frame]!)} ${chalk.dim(`${phrase}${tokenText}`)}`,
      width,
    ));
    let hasLiveRows = false;
    this.thinkingHeaderRow.setText("");
    this.thinkingEllipsisRow.setText("");
    this.reasoningGapRow.setLines(0);
    this.timelineEllipsisRow.setText("");
    for (const row of this.reasoningRows) row.setText("");
    for (const row of this.timelineRows) row.clear();
    // Reasoning models get a dedicated rolling window instead of burying
    // their work inside the spinner status line. It is an independent region:
    // answer/tool bytes must not make Thinking disappear mid-frame.
    if (tail.reasoning) {
      hasLiveRows = true;
      const projected = projectReasoningRows(
        tail.reasoning,
        { ...projectionOptions, columns: width },
        { running: true, maxBodyRows: MINIMAL_REASONING_BODY_ROWS, fromEnd: true },
      );
      this.thinkingHeaderRow.setText(projected[0] ?? "");
      const body = projected.slice(1);
      const visible = body.slice(0, this.reasoningRows.length);
      for (let index = 0; index < visible.length; index += 1) {
        this.reasoningRows[index]!.setText(visible[index] ?? "");
      }
      if (body.length > visible.length) this.thinkingEllipsisRow.setText(body.at(-1) ?? "");
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
    const timelineBlocks: TranscriptProjection[] = [];
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]!;
      if (part.type === "tools") {
        timelineBlocks.push(projectToolTraceGroups(
          part.toolCalls,
          { ...projectionOptions, columns: width },
          { showActivity: partIndex === lastToolsPart },
        ));
        continue;
      }
      const rows = projectAssistantRows(part.content, { ...projectionOptions, columns: width });
      timelineBlocks.push({ rows, traceTargets: rows.map(() => undefined) });
    }
    const timeline = joinTranscriptProjections(timelineBlocks);
    this.reasoningGapRow.setLines(tail.reasoning && timeline.rows.length > 0 ? 1 : 0);
    if (timeline.rows.length > 0) {
      hasLiveRows = true;
      const start = Math.max(0, timeline.rows.length - this.timelineRows.length);
      const visible = timeline.rows.slice(start);
      const visibleTargets = timeline.traceTargets.slice(start);
      this.timelineEllipsisRow.setText(timeline.rows.length > visible.length ? chalk.dim("  …") : "");
      for (let index = 0; index < visible.length; index += 1) {
        this.timelineRows[index]!.setRow(
          visible[index]!,
          visibleTargets[index],
          projectionOptions.traceInteraction,
        );
      }
    }
    this.liveGapRow.setLines(hasLiveRows ? 1 : 0);
  }

  /**
   * Turn ended: collapse every scrollable slot and clear (but do not collapse)
   * the permanent activity lane. Same-frame with the controller's settled
   * append, the full answer replaces the preview without changing the
   * transcript/composer boundary height.
   */
  clearToNothing(): void {
    this.stopSpinner();
    this.tail = null;
    this.thinkingHeaderRow.setText("");
    this.activityLane.setText("");
    this.thinkingEllipsisRow.setText("");
    this.reasoningGapRow.setLines(0);
    this.timelineEllipsisRow.setText("");
    this.liveGapRow.setLines(0);
    for (const row of this.reasoningRows) row.setText("");
    for (const row of this.timelineRows) row.clear();
  }

  startSpinner(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      if (this.tail) {
        // Re-render just the glyph by re-running the status text build.
        const keep = this.tail;
        this.update(keep, this.lastColumns ?? 80, this.projectionOptions);
      }
      this.onFrame?.();
    }, 100);
    this.phraseTimer = setInterval(() => {
      if (!this.tail || this.tail.content || this.tail.reasoning || this.tail.tools.length > 0) return;
      this.idlePhraseIndex = (this.idlePhraseIndex + 1) % GENERIC_PHRASES.length;
      this.update(this.tail, this.lastColumns ?? 80, this.projectionOptions);
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
