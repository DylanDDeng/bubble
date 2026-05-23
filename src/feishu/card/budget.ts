/**
 * Card size budget. Two limits matter:
 *   - per-element: ~30KB on `cardElement.content` updates (Feishu error 11310)
 *   - per-card total: ~150KB on the patch request body
 *
 * Strategy:
 *   1. Truncate any single element text to maxBytesPerElement, marking it.
 *   2. If the rendered card serializes above maxBytesPerCard, collapse the
 *      *oldest* tool blocks first into one-line summaries, keeping the most
 *      recent few intact. Text/thinking blocks are truncated from the head.
 */

import type { RunState, ToolBlock } from "./run-state-types.js";

export interface BudgetOptions {
  maxBytesPerElement: number;
  maxBytesPerCard: number;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Return a truncated version of `text` such that its UTF-8 byte size is
 * at most `maxBytes`. Adds a trailing ellipsis when truncation happens.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const ellipsis = "…"; // U+2026 == 3 UTF-8 bytes
  const ellipsisBytes = utf8Bytes(ellipsis);
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  // Binary search for the largest prefix that fits within `budget` bytes.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (utf8Bytes(text.slice(0, mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + ellipsis;
}

/**
 * Reduce `state.blocks` so that each block's user-visible text fits within
 * `maxBytesPerElement`. Does not enforce total-card budget — see
 * `applyCardBudget` for that.
 */
export function clampBlocksToElementBudget(state: RunState, maxBytesPerElement: number): void {
  for (const block of state.blocks) {
    switch (block.kind) {
      case "text":
        block.text = truncateToBytes(block.text, maxBytesPerElement);
        break;
      case "thinking":
        block.text = truncateToBytes(block.text, maxBytesPerElement);
        break;
      case "tool":
        block.argsPreview = truncateToBytes(block.argsPreview, Math.min(maxBytesPerElement, 4000));
        if (block.resultPreview) {
          block.resultPreview = truncateToBytes(block.resultPreview, Math.min(maxBytesPerElement, 8000));
        }
        break;
    }
  }
}

/**
 * Best-effort compress to fit the card's total byte budget. Mutates `state`.
 *
 * Heuristics (run until under budget or no more reductions possible):
 *   1. Collapse all completed tool blocks except the last 2 into one-line summaries
 *   2. Truncate text blocks from the head to half their current size
 *   3. Drop the oldest text/thinking blocks entirely
 *
 * The estimator uses a rough serialization length (sum of relevant fields)
 * rather than the actual card JSON — cheap enough to call per update.
 */
export function applyCardBudget(state: RunState, opts: BudgetOptions): void {
  clampBlocksToElementBudget(state, opts.maxBytesPerElement);

  if (estimateBytes(state) <= opts.maxBytesPerCard) return;

  // Step 1: collapse old completed tool blocks (keep newest 2 verbose).
  const toolIndices: number[] = [];
  for (let i = 0; i < state.blocks.length; i++) {
    if (state.blocks[i]!.kind === "tool") toolIndices.push(i);
  }
  const keepVerboseTools = toolIndices.slice(-2);
  for (const idx of toolIndices) {
    if (keepVerboseTools.includes(idx)) continue;
    const tool = state.blocks[idx] as ToolBlock;
    if (tool.status === "running") continue;
    // Replace verbose preview with a 60-char summary.
    if (tool.resultPreview) {
      tool.resultPreview = truncateToBytes(tool.resultPreview, 200);
    }
    tool.argsPreview = truncateToBytes(tool.argsPreview, 80);
  }
  if (estimateBytes(state) <= opts.maxBytesPerCard) return;

  // Step 2: halve text blocks from the head until under budget.
  for (const block of state.blocks) {
    if (block.kind !== "text" && block.kind !== "thinking") continue;
    if (block.text.length > 200) {
      block.text = "…" + block.text.slice(Math.floor(block.text.length / 2));
    }
    if (estimateBytes(state) <= opts.maxBytesPerCard) return;
  }

  // Step 3: drop oldest text/thinking blocks (keep tool history intact).
  while (estimateBytes(state) > opts.maxBytesPerCard && state.blocks.length > 0) {
    const idx = state.blocks.findIndex((b) => b.kind === "text" || b.kind === "thinking");
    if (idx === -1) break;
    state.blocks.splice(idx, 1);
  }
}

function estimateBytes(state: RunState): number {
  let total = 256; // header / footer / scaffold
  for (const block of state.blocks) {
    switch (block.kind) {
      case "text":
        total += utf8Bytes(block.text) + 32;
        break;
      case "thinking":
        total += utf8Bytes(block.text) + 48;
        break;
      case "tool":
        total += utf8Bytes(block.name) + utf8Bytes(block.argsPreview) + 64;
        if (block.resultPreview) total += utf8Bytes(block.resultPreview);
        break;
    }
  }
  return total;
}
