/**
 * RunState → Feishu interactive card JSON (v1 schema).
 *
 * Schema reference:
 *   - top-level: { config, header, elements }
 *   - element tags: 'markdown' | 'div' | 'hr' | 'note' | 'action'
 *   - card config MUST include `update_multi: true` to be patch-able
 *
 * The `LarkChannel.stream({ card: { initial, producer } })` path consumes
 * exactly this shape — the producer calls `ctrl.update(nextCard)` with a
 * fresh render on each agent event.
 */

import type { RunState, RunStatus } from "./run-state-types.js";
import { applyCardBudget, type BudgetOptions } from "./budget.js";
import { formatPermissionMode } from "../format.js";

const STATUS_ICON: Record<RunStatus, string> = {
  running: "🟢",
  completed: "✅",
  interrupted: "⏹",
  error: "🟥",
  idle_timeout: "⏱",
};

const STATUS_TEMPLATE: Record<RunStatus, string> = {
  running: "blue",
  completed: "green",
  interrupted: "grey",
  error: "red",
  idle_timeout: "yellow",
};

const STATUS_TITLE: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  interrupted: "Interrupted",
  error: "Error",
  idle_timeout: "Idle Timeout",
};

const TOOL_ICON = {
  running: "⏳",
  ok: "✅",
  err: "❌",
} as const;

export interface RenderOptions {
  budget: BudgetOptions;
  /** Whether to render a Stop button while running. Default: true. */
  showStopButton?: boolean;
  /** Opaque token to identify this run for button callbacks. */
  runToken?: string;
}

export function renderCard(state: RunState, opts: RenderOptions): object {
  applyCardBudget(state, opts.budget);

  const showStop = opts.showStopButton !== false && state.status === "running";
  const elements = buildElements(state, showStop, opts.runToken);

  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: buildHeaderTitle(state) },
      template: STATUS_TEMPLATE[state.status],
    },
    elements,
  };
}

function buildHeaderTitle(state: RunState): string {
  const icon = STATUS_ICON[state.status];
  const title = STATUS_TITLE[state.status];
  return `${icon} ${title} · ${state.scope.displayName}`;
}

function buildElements(state: RunState, showStop: boolean, runToken: string | undefined): object[] {
  const elements: object[] = [];

  // Top note: cwd + mode badges
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `📁 ${state.scope.cwd}    🛡 ${formatPermissionMode(state.mode)}`,
      },
    ],
  });

  elements.push({ tag: "hr" });

  // Blocks
  if (state.blocks.length === 0) {
    elements.push({ tag: "markdown", content: "_思考中…_" });
  }

  for (const block of state.blocks) {
    switch (block.kind) {
      case "text":
        elements.push({
          tag: "markdown",
          content: escapeMarkdownContent(block.text) + (block.streaming ? " ▌" : ""),
        });
        break;
      case "thinking":
        elements.push({
          tag: "markdown",
          content: `> _💭 思考_\n> ${quoteLines(block.text)}${block.streaming ? " ▌" : ""}`,
        });
        break;
      case "tool": {
        const icon = TOOL_ICON[block.status];
        const head = `**${icon} ${block.name}**`;
        const argsLine = block.argsPreview ? `\n\`${escapeInlineCode(block.argsPreview)}\`` : "";
        const resultLine = block.resultPreview
          ? `\n\n${escapeMarkdownContent(block.resultPreview)}`
          : "";
        elements.push({
          tag: "markdown",
          content: head + argsLine + resultLine,
        });
        break;
      }
    }
  }

  elements.push({ tag: "hr" });

  // Footer: usage + elapsed + stop button
  const footerParts: string[] = [];
  if (state.usage) {
    const total = state.usage.totalTokens
      ?? ((state.usage.promptTokens ?? 0) + (state.usage.completionTokens ?? 0));
    footerParts.push(`📊 ${formatTokenCount(total)} tokens`);
  }
  footerParts.push(`⏱ ${formatElapsed(state.updatedAt - state.startedAt)}`);
  if (state.error?.message) {
    footerParts.push(`⚠ ${truncate(state.error.message, 200)}`);
  }
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: footerParts.join("    ") }],
  });

  if (showStop && runToken) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "⏹ 停止" },
          type: "danger",
          value: { __bubble: "stop_run", runToken },
        },
      ],
    });
  }

  return elements;
}

function escapeMarkdownContent(text: string): string {
  // Feishu markdown rendering is mostly Github-flavored but doesn't tolerate
  // unescaped pipe / backtick characters well in cards. We do a minimal
  // pass: keep code fences intact, but ensure no element value is empty.
  if (!text.trim()) return "_(empty)_";
  return text;
}

function escapeInlineCode(text: string): string {
  // Inline code uses single backticks; replace any backtick in the value
  // with U+2018 to avoid breaking out of the code span.
  return text.replace(/`/g, "ʼ");
}

function quoteLines(text: string): string {
  return text.split("\n").join("\n> ");
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
