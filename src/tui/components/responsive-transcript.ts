/**
 * Stable transcript component.
 *
 * The component tree keeps this object for the lifetime of the TUI. Its rows
 * are projected from message state at render time, so a terminal resize uses
 * the new width instead of mechanically wrapping ANSI strings produced for an
 * old width. This also makes message identity independent from rendered row
 * count (which changes with Markdown, CJK, and terminal width).
 */
import type { Component, TuiMouseEvent } from "@bubblebrain-ai/pi-tui";
import type { DisplayMessage } from "../model/display-history.js";
import type { TraceInteractionState, TraceRowTarget } from "../model/trace-interaction.js";
import { projectTranscript, type TranscriptRenderOptions } from "./transcript.js";

export interface ResponsiveTranscriptSnapshot {
  messages: readonly DisplayMessage[];
  options?: Omit<TranscriptRenderOptions, "columns">;
}

export class ResponsiveTranscriptComponent implements Component {
  private traceTargets: Array<TraceRowTarget | undefined> = [];
  private traceInteraction?: TraceInteractionState;

  constructor(private readonly getSnapshot: () => ResponsiveTranscriptSnapshot) {}

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    const projection = projectTranscript(snapshot.messages, {
      ...snapshot.options,
      columns: Math.max(1, width),
    });
    this.traceTargets = projection.traceTargets;
    this.traceInteraction = snapshot.options?.traceInteraction;
    return projection.rows;
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (!this.traceInteraction) return false;
    if (event.kind === "leave") return this.traceInteraction.clearHover();
    const target = this.traceTargets[event.y];
    if (event.kind === "move") return this.traceInteraction.hover(target);
    if (event.release || (event.button & 3) !== 0 || !target) return false;
    this.traceInteraction.activate(target, event.clickCount);
    return true;
  }

  invalidate(): void {
    // No width-sensitive cache: render() always projects current message state.
  }
}
