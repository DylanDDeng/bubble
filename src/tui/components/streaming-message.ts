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
import { Text, VStack } from "@bubblebrain-ai/pi-tui";

export interface StreamingTailState {
  content: string;
  reasoning: string;
  toolCount: number;
  lastToolName?: string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class StreamingMessageComponent extends VStack {
  private tail: StreamingTailState | null = null;
  private frame = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onFrame?: () => void;

  // Persistent row pool — NEVER re-created, only setText.
  private readonly statusRow: Text;
  private readonly ellipsisRow: Text;
  private readonly previewRows: Text[];

  constructor(maxPreviewRows = 8, onFrame?: () => void) {
    super([]);
    this.onFrame = onFrame;
    this.statusRow = new Text("", 0, 0);
    this.ellipsisRow = new Text("", 0, 0);
    this.previewRows = Array.from({ length: maxPreviewRows }, () => new Text("", 0, 0));
    this.addChild(this.statusRow);
    this.addChild(this.ellipsisRow);
    for (const row of this.previewRows) this.addChild(row);
  }

  /** Live update while streaming. */
  update(tail: StreamingTailState, columns: number): void {
    this.tail = tail;
    const status = tail.content
      ? "Streaming…"
      : tail.toolCount > 0 && tail.lastToolName
        ? `Running ${tail.lastToolName}…`
        : tail.reasoning
          ? "Thinking…"
          : "Connecting…";
    this.statusRow.setText(` ${chalk.cyan(SPINNER_FRAMES[this.frame]!)} ${chalk.dim(status)}`);

    let slot = 0;
    const put = (line: string) => {
      if (slot < this.previewRows.length) this.previewRows[slot++]!.setText(line);
    };

    // Pre-first-token: last couple of reasoning lines, dim.
    if (tail.reasoning && !tail.content) {
      for (const line of tail.reasoning.split("\n").slice(-2)) {
        put(chalk.dim(`  ${line.slice(0, Math.max(8, columns - 4))}`));
      }
    }

    // Growing answer preview: plain clamped tail keeps row churn minimal.
    if (tail.content) {
      const lines = tail.content.split("\n");
      const preview = lines.slice(-this.previewRows.length);
      this.ellipsisRow.setText(lines.length > this.previewRows.length ? chalk.dim("  …") : "");
      for (const line of preview) put(line.slice(0, Math.max(8, columns - 2)));
    } else {
      this.ellipsisRow.setText("");
      if (tail.toolCount > 0 && tail.lastToolName) {
        put(chalk.dim(`  ⚙ ${tail.lastToolName} (tool ${tail.toolCount})`));
      }
    }

    // Clear any remaining slots.
    for (; slot < this.previewRows.length; slot++) this.previewRows[slot]!.setText("");
  }

  /**
   * Turn ended: collapse every slot. Same-frame with the controller's
   * settled append so the full answer replaces the preview without a
   * duplicated or stale frame.
   */
  clearToNothing(): void {
    this.stopSpinner();
    this.tail = null;
    this.statusRow.setText("");
    this.ellipsisRow.setText("");
    for (const row of this.previewRows) row.setText("");
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
    }, 80);
  }

  private lastColumns?: number;

  stopSpinner(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
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
