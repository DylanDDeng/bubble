/**
 * Intents are the single entry point into the controller. UI layers
 * (composer, pickers, dialogs, keyboard shortcuts) translate raw input into
 * intents; the controller owns validation, ordering, and state transitions.
 */

export type ShutdownReason = "user-quit" | "sigterm" | "sigint" | "error";

export type BubbleTuiIntent =
  | { type: "submit"; text: string; images?: unknown[] }
  | { type: "cancel-run" }
  | { type: "steer"; text: string }
  | { type: "queue-input"; text: string; images?: unknown[] }
  | { type: "open-picker"; picker: string }
  | { type: "close-picker" }
  | { type: "toggle-thinking" }
  | { type: "toggle-verbose-trace" }
  | { type: "cycle-thinking" }
  | { type: "cycle-permission" }
  | { type: "switch-session"; file: string }
  | { type: "start-fresh-session" }
  | { type: "execute-command"; command: string }
  | { type: "set-composer-draft"; text: string | null }
  | { type: "promote-task"; taskId: string }
  | { type: "kill-task"; taskId: string }
  | { type: "set-focus"; target: "composer" | "subagent-entry" }
  | { type: "shutdown"; reason: ShutdownReason };
