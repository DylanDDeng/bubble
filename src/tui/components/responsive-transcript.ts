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
import type { TraceAction, TraceInteractionState, TraceRowTarget } from "../model/trace-interaction.js";
import {
  projectTranscript,
  type TranscriptProjection,
  type TranscriptRenderOptions,
} from "./transcript.js";

export interface ResponsiveTranscriptSnapshot {
  messages: readonly DisplayMessage[];
  options?: Omit<TranscriptRenderOptions, "columns">;
}

export interface ResponsiveTranscriptCallbacks {
  onTraceAction?(action: TraceAction): void;
}

export class ResponsiveTranscriptComponent implements Component {
  private traceTargets: Array<TraceRowTarget | undefined> = [];
  private traceInteraction?: TraceInteractionState;
  private cache?: {
    messages: readonly DisplayMessage[];
    width: number;
    showReasoning: boolean;
    verboseTrace: boolean;
    trailingSpacer: boolean;
    theme: TranscriptRenderOptions["theme"];
    markdownRenderer: TranscriptRenderOptions["markdownRenderer"];
    traceInteraction: TraceInteractionState | undefined;
    traceRevision: number;
    projection: TranscriptProjection;
  };

  constructor(
    private readonly getSnapshot: () => ResponsiveTranscriptSnapshot,
    private readonly callbacks: ResponsiveTranscriptCallbacks = {},
  ) {}

  render(width: number): string[] {
    const snapshot = this.getSnapshot();
    const options = snapshot.options ?? {};
    const normalizedWidth = Math.max(1, width);
    const showReasoning = options.showReasoning ?? false;
    const verboseTrace = options.verboseTrace ?? false;
    const trailingSpacer = options.trailingSpacer !== false;
    const traceRevision = options.traceInteraction?.getRevision() ?? 0;
    const cached = this.cache;
    const projection = cached
      && cached.messages === snapshot.messages
      && cached.width === normalizedWidth
      && cached.showReasoning === showReasoning
      && cached.verboseTrace === verboseTrace
      && cached.trailingSpacer === trailingSpacer
      && cached.theme === options.theme
      && cached.markdownRenderer === options.markdownRenderer
      && cached.traceInteraction === options.traceInteraction
      && cached.traceRevision === traceRevision
      ? cached.projection
      : projectTranscript(snapshot.messages, {
          ...options,
          columns: normalizedWidth,
        });

    if (projection !== cached?.projection) {
      this.cache = {
        messages: snapshot.messages,
        width: normalizedWidth,
        showReasoning,
        verboseTrace,
        trailingSpacer,
        theme: options.theme,
        markdownRenderer: options.markdownRenderer,
        traceInteraction: options.traceInteraction,
        traceRevision,
        projection,
      };
    }
    this.traceTargets = projection.traceTargets;
    this.traceInteraction = options.traceInteraction;
    return projection.rows;
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (!this.traceInteraction) return false;
    if (event.kind === "leave") return this.traceInteraction.clearHover();
    const target = this.traceTargets[event.y];
    if (event.kind === "move") return this.traceInteraction.hover(target);
    if (event.release || (event.button & 3) !== 0 || !target) return false;
    const action = this.traceInteraction.activate(target, event.clickCount);
    if (action) this.callbacks.onTraceAction?.(action);
    return true;
  }

  invalidate(): void {
    // Theme/capability changes can alter ANSI output without changing the
    // immutable transcript reference. Width changes already miss naturally.
    this.cache = undefined;
  }
}
