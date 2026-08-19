/**
 * Stable transcript component.
 *
 * The component tree keeps this object for the lifetime of the TUI. Its rows
 * are projected from message state at render time, so a terminal resize uses
 * the new width instead of mechanically wrapping ANSI strings produced for an
 * old width. This also makes message identity independent from rendered row
 * count (which changes with Markdown, CJK, and terminal width).
 */
import type { Component } from "@bubblebrain-ai/pi-tui";
import type { DisplayMessage } from "../model/display-history.js";
import { renderTranscript, type TranscriptRenderOptions } from "./transcript.js";

export interface ResponsiveTranscriptSnapshot {
  messages: readonly DisplayMessage[];
  options?: Omit<TranscriptRenderOptions, "columns">;
}

export class ResponsiveTranscriptComponent implements Component {
  constructor(private readonly getSnapshot: () => ResponsiveTranscriptSnapshot) {}

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    return renderTranscript(snapshot.messages, {
      ...snapshot.options,
      columns: Math.max(1, width),
    });
  }

  invalidate(): void {
    // No width-sensitive cache: render() always projects current message state.
  }
}
