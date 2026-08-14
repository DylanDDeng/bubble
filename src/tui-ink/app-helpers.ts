/**
 * Pure helpers for the Ink app: welcome tips, status-row summaries,
 * cwd/session labels, truncation, context-usage formatting, partial
 * streaming-arg extraction, display-message keying, and the scrolling-window
 * clamp shared by the picker overlays.
 */
import os from "node:os";
import type { Agent } from "../agent.js";
import { displayModel, type ProviderRegistry } from "../provider-registry.js";
import type { BackgroundTaskInfo } from "../tasks/manager.js";
import { nextDisplayMessageKey, type DisplayMessage } from "./display-history.js";

export const TASK_WAKE_DEBOUNCE_MS = 2000;
export function buildTips(agent: Agent, registry: ProviderRegistry, grokActive = false): string[] {
  const tips: string[] = [];
  if (grokActive) {
    return [
      "Grok Subscription is active with workspace tools and Bubble approvals",
      "Use /model to choose the Grok model and reasoning effort",
      "Use /logout grok to return to a fresh native session",
    ];
  }
  const hasProvider = registry.getEnabled().length > 0;
  if (!hasProvider) {
    tips.push("Run /login or /provider --add to configure a model");
  } else if (agent.model) {
    tips.push(`Ready with ${displayModel(agent.model)}`);
  } else {
    tips.push("Run /model to pick a model");
  }
  tips.push("Type @ to reference a file");
  tips.push("Type / for commands and skills");
  return tips;
}

/**
 * Slash-command results arrive as plain strings; recognize the /model
 * confirmations by shape so they render as accent-colored UI notices — the
 * same treatment the picker path applies — instead of assistant prose.
 */
export function slashResultNoticeKind(result: string): DisplayMessage["syntheticKind"] | undefined {
  return /^(Grok m|M)odel switched to /.test(result) ? "ui_notice" : undefined;
}

/** Status-row summary for running background tasks (design §2.5). */
export function taskRowSummary(tasks: BackgroundTaskInfo[], nowTick: number): string {
  const first = tasks[0]!;
  const label = first.description?.trim() || first.command.replace(/\s+/g, " ").slice(0, 32);
  const elapsed = Math.max(0, Math.round((nowTick - first.startedAt) / 1000));
  return `${label} ${elapsed}s`;
}

export function friendlyCwd(cwd: string): string {
  const home = os.homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export function sessionBasename(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  const base = sessionFile.split("/").pop() ?? sessionFile;
  return base.replace(/\.jsonl$/, "");
}

export function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function formatCompactTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
}

export function formatContextUsageLabel(snapshot: { usedTokens: number; contextWindow?: number }): string {
  if (!snapshot.contextWindow || snapshot.contextWindow <= 0) {
    return `${formatCompactTokens(snapshot.usedTokens)} context`;
  }
  const percent = (snapshot.usedTokens / snapshot.contextWindow) * 100;
  const label = percent >= 10
    ? `${Math.round(percent)}%`
    : percent >= 0.05
      ? `${percent.toFixed(1)}%`
      : "<0.1%";
  return `${label} context`;
}

/**
 * Streaming tool arguments arrive as an incomplete JSON buffer. We can't
 * JSON.parse() until the closing brace lands, but the user wants to see the
 * short identifying fields (path, command, …) as soon as the model emits
 * them so the tool row header reflects what's happening.
 *
 * Intentionally limited to short, single-line fields. Long fields like
 * `content` are *not* surfaced live: rendering thousands of partial lines
 * per delta floods the terminal and the partial value can break around
 * unescaped sequences. The final value lands when the tool actually
 * executes and tool_start delivers canonical args.
 */
export function parsePartialArgs(
  buffer: string,
  previous: Record<string, any>,
): Record<string, any> {
  // If the buffer is now valid JSON, prefer the real parse.
  try {
    const parsed = JSON.parse(buffer);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through to partial extraction below
  }
  const result: Record<string, any> = { ...previous };
  const FIELDS = ["path", "command", "pattern", "url", "query"];
  for (const field of FIELDS) {
    // Match a complete-looking quoted string. Requires a closing quote so we
    // don't surface half-typed paths that may still change as bytes arrive.
    const match = buffer.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (match) {
      const raw = match[1] ?? "";
      result[field] = raw
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }
  return result;
}

/**
 * Coerce a freshly-constructed DisplayMessage into one that carries a stable
 * `key`. Centralizes the safety net so callers don't have to remember to call
 * nextDisplayMessageKey on every push.
 */
export function withMessageKey(message: DisplayMessage): DisplayMessage {
  if (message.key) return message;
  const prefix = message.role === "user" ? "user" : message.role === "error" ? "err" : "asst";
  return { ...message, key: nextDisplayMessageKey(prefix) };
}

// Batch streaming text deltas before committing them to React state. Without
// <Static>, every commit re-renders the full-screen frame; per-token commits
// would make Yoga re-lay-out the transcript for every few bytes of output.
// 40ms keeps perceived latency invisible while capping layout work at 25fps.
export const STREAMING_FLUSH_INTERVAL_MS = 40;

export function clampWindowStartForIndex(total: number, selectedIndex: number, maxVisible: number): number {
  if (total <= maxVisible) return 0;
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedIndex - half);
  if (start + maxVisible > total) start = total - maxVisible;
  return Math.max(0, start);
}
