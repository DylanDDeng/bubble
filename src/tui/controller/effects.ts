/**
 * Effects are the controller's only vocabulary for side effects. The pure
 * reducers (agent-event-reducer, input-queue) return them; the controller
 * applies them against its state and ports. Renderers observe state changes
 * through snapshots, never effects.
 */
import type { DisplayMessage } from "../model/display-history.js";

export type ControllerEffect =
  | { kind: "stream-cleared" }
  | { kind: "stream-flushed" }
  | { kind: "tools-updated" }
  | { kind: "live-subagent-changed" }
  | { kind: "assistant-committed"; taskElapsedMs?: number }
  | { kind: "permission-mode-changed"; mode: string }
  | { kind: "transcript-append"; message: DisplayMessage }
  | { kind: "transcript-move-message"; displayKey: string; fullReprint: boolean }
  | { kind: "transcript-rebuild-from-agent"; fullReprint: boolean }
  | { kind: "session-append-message"; role: "user"; content: string }
  | { kind: "queue-updated" }
  | { kind: "external-cancel"; sessionId: string }
  | { kind: "run-error"; error: unknown }
  | { kind: "notice"; role: "assistant" | "error"; text: string };
