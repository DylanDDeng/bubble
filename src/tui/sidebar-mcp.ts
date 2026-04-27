/**
 * Pure helpers for the TUI MCP sidebar widget.
 *
 * Kept separate from run.ts so they can be unit-tested without mounting the
 * full opentui renderer. run.ts imports sidebarMcpRowsFromStates and
 * renderMcpRowMarker for display; everything else stays in-TUI because it
 * depends on theme / renderable construction.
 */

import type { McpServerState } from "../mcp/types.js";

const ERROR_LABEL_MAX = 32;

export interface SidebarMcpRow {
  name: string;
  kind: "connected" | "failed" | "disabled";
  label: string;
  toolCount: number;
  promptCount: number;
  errorDetail?: string;
  canReconnect: boolean;
}

function truncateInline(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * Project raw McpServerState[] (from McpManager.getStates()) into the display
 * shape consumed by the sidebar's row renderer. Deterministic and side-effect
 * free — the single source of truth for what the widget shows per server.
 */
export function sidebarMcpRowsFromStates(states: McpServerState[]): SidebarMcpRow[] {
  return states.map((state) => {
    const kind = state.status.kind;
    const toolCount = kind === "connected" ? state.status.tools.length : 0;
    const promptCount = kind === "connected" ? state.status.prompts.length : 0;
    const errorDetail = kind === "failed" ? state.status.error : undefined;

    let label: string;
    if (kind === "connected") {
      const parts: string[] = [];
      parts.push(`${toolCount} tool${toolCount === 1 ? "" : "s"}`);
      if (promptCount > 0) {
        parts.push(`${promptCount} prompt${promptCount === 1 ? "" : "s"}`);
      }
      label = parts.join(", ");
    } else if (kind === "failed") {
      label = truncateInline(state.status.error, ERROR_LABEL_MAX);
    } else {
      label = "disabled";
    }

    return {
      name: state.name,
      kind,
      label,
      toolCount,
      promptCount,
      errorDetail,
      canReconnect: kind === "failed" || kind === "disabled",
    };
  });
}

/**
 * Single-char status marker used at the start of each sidebar row.
 * Mirrors opencode's convention so a connected row reads as a bullet, failed
 * as a cross, disabled as a hollow circle. Colour is applied separately by
 * the caller using theme mapping.
 */
export function renderMcpRowMarker(kind: SidebarMcpRow["kind"]): string {
  if (kind === "connected") return "●";
  if (kind === "failed") return "✗";
  return "○";
}
