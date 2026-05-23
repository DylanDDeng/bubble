/**
 * RunState → Feishu interactive card JSON (v1 schema).
 *
 * Schema reference:
 *   - top-level: { config, header, elements }
 *   - element tags: 'markdown' | 'div' | 'hr' | 'note' | 'action' | 'collapsible_panel'
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
  /**
   * Use `collapsible_panel` elements to hide thinking + finished tool detail.
   * Default true. Set false if your Feishu card host doesn't render the
   * `collapsible_panel` tag — completed tools fall back to a chip + one-line
   * result preview, and thinking falls back to a compact status note.
   */
  collapsible?: boolean;
}

export function renderCard(state: RunState, opts: RenderOptions): object {
  applyCardBudget(state, opts.budget);

  const showStop = opts.showStopButton !== false && state.status === "running";
  const useCollapsible = opts.collapsible !== false;
  const elements = buildElements(state, showStop, opts.runToken, useCollapsible);

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

function buildElements(
  state: RunState,
  showStop: boolean,
  runToken: string | undefined,
  useCollapsible: boolean,
): object[] {
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
      case "thinking": {
        if (!block.text.trim()) break;
        if (!useCollapsible) {
          // Fallback: omit body, just hint that thinking happened/is happening.
          elements.push({
            tag: "note",
            elements: [{
              tag: "plain_text",
              content: block.streaming ? "💭 思考中…" : "💭 思考已折叠",
            }],
          });
          break;
        }
        const title = block.streaming ? "💭 思考中…" : "💭 思考过程";
        elements.push(
          collapsiblePanel(title, [
            {
              tag: "markdown",
              content: `> ${quoteLines(block.text)}${block.streaming ? " ▌" : ""}`,
            },
          ]),
        );
        break;
      }
      case "tool": {
        const icon = TOOL_ICON[block.status];
        if (block.status === "running") {
          // In-flight: keep visible so the user can see what's happening now.
          const head = `**${icon} ${block.name}**`;
          const argsLine = block.argsPreview ? `\n\`${escapeInlineCode(block.argsPreview)}\`` : "";
          elements.push({ tag: "markdown", content: head + argsLine });
        } else {
          // Completed: chip header, full args (only if truncated in title) +
          // result tucked into a collapsible panel.
          const CHIP_ARGS_LIMIT = 60;
          const chipTitle = buildToolChipTitle(icon, block.name, block.argsPreview, CHIP_ARGS_LIMIT);
          if (!useCollapsible) {
            // Fallback: chip title + one-line result preview, no expansion.
            const oneLineResult = block.resultPreview
              ? `\n${truncate(block.resultPreview.replace(/\s+/g, " ").trim(), 160)}`
              : "";
            elements.push({ tag: "markdown", content: chipTitle + oneLineResult });
            break;
          }
          const detail: object[] = [];
          if (block.argsPreview && block.argsPreview.length > CHIP_ARGS_LIMIT) {
            detail.push({
              tag: "markdown",
              content: `**args:** \`${escapeInlineCode(block.argsPreview)}\``,
            });
          }
          if (block.resultPreview) {
            detail.push({
              tag: "markdown",
              content: escapeMarkdownContent(block.resultPreview),
            });
          }
          if (detail.length === 0) {
            elements.push({ tag: "markdown", content: chipTitle });
          } else {
            elements.push(collapsiblePanel(chipTitle, detail));
          }
        }
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

function collapsiblePanel(headerMarkdown: string, elements: object[]): object {
  return {
    tag: "collapsible_panel",
    expanded: false,
    background_color: "grey-100",
    header: {
      title: { tag: "markdown", content: headerMarkdown },
      vertical_align: "center",
      padding: "4px 0px 4px 8px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    elements,
  };
}

function buildToolChipTitle(icon: string, name: string, argsPreview: string, limit: number): string {
  const head = `**${icon} ${name}**`;
  if (!argsPreview) return head;
  const inline = truncate(argsPreview, limit);
  return `${head} · \`${escapeInlineCode(inline)}\``;
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
