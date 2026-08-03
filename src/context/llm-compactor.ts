// LLM-driven context compaction.
//
// When the budget says we're approaching the context window, ask the model to
// produce a handoff summary of the conversation so far. Replace the bulky middle
// of history with that summary while keeping the initial system context and the
// user's latest ask intact. Architecturally this mirrors Codex CLI's approach
// (codex-rs/core/src/compact.rs + templates/compact/prompt.md): trust the model
// to pick what matters instead of writing a template.
//
// Failure modes are explicit: returns { compacted: false, reason } so the
// caller can fall back to algorithmic compaction without an exception.

import type { Message, Provider, ProviderMessage, ToolCall } from "../types.js";
import { sanitizeInternalReminderBlocks } from "../agent/internal-reminder-sanitizer.js";
import { estimateContextTokens } from "./budget.js";
import { appendFileBlocks, stripFileBlocks } from "./compaction-files.js";
import {
  collectCompactionFileOps,
  messageText,
  buildCompactionSummaryMessage,
  clonePinnedUserMessage,
  findFirstRealUserIndex,
  isCompactionSummaryMessage,
  isRealUserMessage,
  splitLeadingContext,
} from "./compact.js";

export const LLM_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const LLM_SUMMARY_PREFIX = `Another language model previously worked on this task and produced this handoff summary. Build on what's already done; avoid re-running the same investigation. Summary:`;

export interface LLMCompactOptions {
  provider: Provider;
  modelId: string;
  /** Compactor model call must complete within this token-cost ceiling. */
  maxInputTokens?: number;
  /** Number of trailing (assistant + tool-results) groups in the current turn to keep verbatim. */
  keepRecentGroups?: number;
  abortSignal?: AbortSignal;
}

export interface LLMCompactResult {
  compacted: boolean;
  summary?: string;
  messages?: Message[];
  reason?: string;
}

export async function compactWithLLM(
  messages: Message[],
  options: LLMCompactOptions,
): Promise<LLMCompactResult> {
  const { provider, modelId, abortSignal } = options;
  const maxInputTokens = options.maxInputTokens ?? 100_000;
  const keepRecentGroups = options.keepRecentGroups ?? 2;

  // Positional leading prefix, not role-global filtering: filtering by role
  // used to relocate mid-history system messages (including prior summaries)
  // to the head, where the projector then fused them into the system prompt.
  const { leading, body: rawBody } = splitLeadingContext(messages);
  // Replace semantics: prior summaries become summarization INPUT (semantic
  // rolling — the compactor model merges them), never preserved copies.
  const priorSummaries = rawBody.filter(isCompactionSummaryMessage);
  const body = rawBody.filter((m) => !isCompactionSummaryMessage(m));

  let lastUserIndex = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (isRealUserMessage(body[i])) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return { compacted: false, reason: "no user message in history" };
  }

  // Pivot the body around the last user message:
  //   priorTurns:   everything from earlier user turns (multi-turn case)
  //   lastUser:     the user's current ask (always kept verbatim)
  //   currentTurn:  the assistant + tool groups produced in response so far
  //
  // The FIRST real user message (the original instruction) is pinned verbatim
  // too: after meta reminders get re-rolled into user role by the projector,
  // "last user message" often points at a reminder, not the instruction — and
  // late requirements in a long instruction must survive compaction.
  const priorTurns = body.slice(0, lastUserIndex);
  const lastUser = body[lastUserIndex];
  const currentTurn = body.slice(lastUserIndex + 1);

  const firstRealUserIndex = findFirstRealUserIndex(body);
  const pinnedFirstUser = firstRealUserIndex >= 0 && firstRealUserIndex < lastUserIndex
    ? body[firstRealUserIndex]
    : undefined;
  const summarizablePriorTurns = pinnedFirstUser
    ? priorTurns.filter((message) => message !== pinnedFirstUser)
    : priorTurns;

  // Split currentTurn into (assistant + its tool results) groups so we can
  // keep the most recent K verbatim and evict the older ones.
  type Group = { assistant: Message; toolResults: Message[] };
  const groups: Group[] = [];
  let active: Group | null = null;
  for (const msg of currentTurn) {
    if (msg.role === "assistant") {
      if (active) groups.push(active);
      active = { assistant: msg, toolResults: [] };
    } else if (msg.role === "tool" && active) {
      active.toolResults.push(msg);
    }
  }
  if (active) groups.push(active);

  const keptGroupCount = Math.min(keepRecentGroups, groups.length);
  const evictedGroups = groups.slice(0, groups.length - keptGroupCount);
  const keptGroups = groups.slice(groups.length - keptGroupCount);

  // What we'll send to the model to summarize: prior summaries (semantic
  // rolling), prior turns, and the older groups in the current turn. The
  // pinned first instruction is excluded — it survives verbatim. File blocks
  // are stripped from prior summaries here: the deterministic merge below owns
  // the file lists, and feeding them to the model only invites a lossy echo.
  const toSummarize: Message[] = [
    ...priorSummaries.map((m): Message => ({
      role: "user",
      content: `[Prior compaction summary]\n${stripFileBlocks(messageText(m))}`,
    })),
    ...summarizablePriorTurns,
    ...evictedGroups.flatMap((g) => [g.assistant, ...g.toolResults]),
  ];

  // Cumulative file tracking (deterministic, never via the model): union the
  // lists the prior summaries carried with the ops in what we're evicting now.
  // Tool results ride along so failed/rejected calls don't count as touches.
  const fileOps = collectCompactionFileOps(
    [...summarizablePriorTurns, ...evictedGroups.flatMap((g) => [g.assistant, ...g.toolResults])],
    priorSummaries,
  );

  if (toSummarize.length === 0) {
    return { compacted: false, reason: "nothing to evict" };
  }

  const trimmedHistory = trimToFitTokenBudget(toSummarize, maxInputTokens);
  const historyText = serializeHistoryAsText(trimmedHistory);

  const summaryInput: ProviderMessage[] = [
    { role: "system", content: LLM_COMPACTION_PROMPT },
    { role: "user", content: historyText },
  ];

  let summaryText: string;
  try {
    summaryText = await provider.complete(summaryInput, {
      model: modelId,
      temperature: 0.2,
      abortSignal,
    });
  } catch (err) {
    return { compacted: false, reason: `compactor call failed: ${(err as Error).message}` };
  }

  if (!summaryText || summaryText.trim().length === 0) {
    return { compacted: false, reason: "compactor returned empty summary" };
  }
  // The summarizer's input transcript can contain projected reminder blocks
  // (resident history holds them after pruned-mode projection), and models
  // quote their input. This summary is persisted via onCompactionApplied, so
  // scrub markup before it can reach the session file.
  summaryText = sanitizeInternalReminderBlocks(summaryText).trim();
  if (!summaryText) {
    return { compacted: false, reason: "compactor returned only internal markup" };
  }

  // New history shape (prefix-cache-friendly: preserved system+meta stay at the
  // absolute prefix unchanged; summary is injected after as a user-role envelope
  // so it can't pollute the cacheable system-prompt prefix):
  //
  //   [...preserved system+meta]                       ← stable prefix
  //   user: "<SUMMARY_PREFIX>\n<summary>"               ← evicted history compressed
  //   user: <original last user message>                ← the current ask
  //   [...kept current-turn (assistant + tool) groups]  ← recent tool work
  const flatKept: Message[] = [];
  for (const g of keptGroups) {
    flatKept.push(cloneMessage(g.assistant));
    for (const t of g.toolResults) flatKept.push(cloneMessage(t));
  }

  const compacted: Message[] = [
    ...leading.map(cloneMessage),
    ...(pinnedFirstUser ? [clonePinnedUserMessage(pinnedFirstUser)] : []),
    buildCompactionSummaryMessage(
      appendFileBlocks(`${LLM_SUMMARY_PREFIX}\n${summaryText}`, fileOps),
    ),
    cloneMessage(lastUser),
    ...flatKept,
  ];

  return {
    compacted: true,
    // Same payload the resident message carries (minus the envelope prefix —
    // session replay adds its own "Previous conversation summary:" header), so
    // the persisted checkpoint matches the in-memory state, file blocks included.
    summary: appendFileBlocks(summaryText, fileOps),
    messages: compacted,
  };
}

function trimToFitTokenBudget(messages: Message[], maxTokens: number): Message[] {
  // Drop from the front (oldest first) until estimate fits. Front-trim matches
  // Codex's pattern and preserves the most recent context the user cares about.
  let working = [...messages];
  while (working.length > 0 && estimateContextTokens(working) > maxTokens) {
    working = working.slice(1);
  }
  return working;
}

function serializeHistoryAsText(messages: Message[]): string {
  const lines: string[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ");
        lines.push(`USER: ${text}`);
        break;
      }
      case "assistant": {
        if (msg.content.trim()) {
          lines.push(`ASSISTANT: ${msg.content}`);
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            toolNameByCallId.set(tc.id, tc.name);
            lines.push(`TOOL_CALL[${tc.name}]: ${summarizeToolCallArgs(tc)}`);
          }
        }
        break;
      }
      case "tool": {
        const name = toolNameByCallId.get(msg.toolCallId) ?? "tool";
        lines.push(`TOOL_RESULT[${name}]: ${truncateInline(msg.content, 1500)}`);
        break;
      }
      default:
        break;
    }
  }

  return lines.join("\n\n");
}

function summarizeToolCallArgs(tc: ToolCall): string {
  try {
    const parsed = JSON.parse(tc.arguments || "{}") as Record<string, unknown>;
    const pairs = Object.entries(parsed)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 200)}`);
    return pairs.join(" ") || "(no args)";
  } catch {
    return truncateInline(tc.arguments || "", 200);
  }
}

function truncateInline(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function cloneMessage(message: Message): Message {
  if (message.role === "assistant") {
    return {
      ...message,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((part) => ({
        ...part,
        ...(part.type === "image_url" ? { image_url: { ...part.image_url } } : {}),
      })),
    };
  }
  return { ...message };
}
