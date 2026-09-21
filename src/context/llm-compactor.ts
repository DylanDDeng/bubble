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
import { estimateTextTokens, getMaxInputTokens } from "./budget.js";
import { getModelContextWindow } from "../model-catalog.js";
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
  PINNED_INSTRUCTION_MAX_CHARS,
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
  /** Total estimated request ceiling, including the compaction prompt. */
  maxInputTokens?: number;
  providerId?: string;
  contextWindow?: number;
  /** Reserved output space and accepted summary token ceiling. */
  maxOutputTokens?: number;
  /** Number of trailing (assistant + tool-results) groups in the current turn to keep verbatim. */
  keepRecentGroups?: number;
  abortSignal?: AbortSignal;
}

export interface LLMCompactResult {
  compacted: boolean;
  summary?: string;
  messages?: Message[];
  reason?: string;
  /** Explicit lossy-input diagnostics; also persisted in a successful summary. */
  degradation?: string;
}

export async function compactWithLLM(
  messages: Message[],
  options: LLMCompactOptions,
): Promise<LLMCompactResult> {
  const { provider, modelId, abortSignal } = options;
  if (abortSignal?.aborted) return { compacted: false, reason: "compactor cancelled" };
  const providerId = options.providerId ?? modelId.split(":")[0];
  const catalogModelId = modelId.startsWith(`${providerId}:`) ? modelId.slice(providerId.length + 1) : modelId;
  // Unknown models use a conservative window rather than an unbounded 100k call.
  const contextWindow = options.contextWindow ?? getModelContextWindow(providerId, catalogModelId) ?? 8192;
  const maxOutputTokens = options.maxOutputTokens ?? Math.min(2048, Math.floor(contextWindow / 4));
  const maxInputTokens = Math.min(
    options.maxInputTokens ?? Infinity,
    getMaxInputTokens(contextWindow) ?? 0,
    contextWindow - maxOutputTokens - 64,
  );
  if (![contextWindow, maxOutputTokens, maxInputTokens].every((n) => Number.isFinite(n) && n > 0)) {
    return { compacted: false, reason: "invalid compactor token budget" };
  }
  const keepRecentGroups = Math.max(0, Math.floor(options.keepRecentGroups ?? 2));

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
    } else if (active) {
      active.toolResults.push(msg);
    } else {
      // Preserve interleaved reminders and other context, not just tool results.
      active = { assistant: msg, toolResults: [] };
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
    // The pin is capped; its tail is protected summary input, never silently lost.
    ...(pinnedFirstUser && messageText(pinnedFirstUser).length > PINNED_INSTRUCTION_MAX_CHARS
      ? [{ role: "user" as const, content: `[Original instruction beyond retained pin]\n${messageText(pinnedFirstUser).slice(PINNED_INSTRUCTION_MAX_CHARS)}` }]
      : []),
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

  const prompt = `${LLM_COMPACTION_PROMPT}\nPreserve prior summary facts and original user constraints. Explicitly report any input omissions. Return no more than ${maxOutputTokens} tokens.`;
  const fitted = fitSummaryInput(toSummarize, prompt, maxInputTokens, providerId);
  if (!fitted) {
    return { compacted: false, reason: "compactor input budget cannot retain prior summaries and user constraints" };
  }
  const { historyText, degradation } = fitted;
  const summaryInput: ProviderMessage[] = [
    { role: "system", content: prompt },
    { role: "user", content: historyText },
  ];
  if (abortSignal?.aborted) return { compacted: false, reason: "compactor cancelled" };

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

  // Some providers resolve even after abort; never apply that late result.
  if (abortSignal?.aborted) return { compacted: false, reason: "compactor cancelled" };
  if (!summaryText || summaryText.trim().length === 0) {
    return { compacted: false, reason: "compactor returned empty summary" };
  }
  // The summarizer's input transcript can contain projected reminder blocks
  // (resident history holds them after pruned-mode projection), and models
  // quote their input. This summary is persisted via onCompactionApplied, so
  // scrub markup before it can reach the session file.
  summaryText = stripFileBlocks(sanitizeInternalReminderBlocks(summaryText)).trim();
  if (!summaryText) {
    return { compacted: false, reason: "compactor returned only internal markup" };
  }

  if (degradation) summaryText = `${degradation}\n\n${summaryText}`;
  const summaryWithFiles = appendFileBlocks(summaryText, fileOps);
  // Reject, rather than silently clipping decisions/constraints from the output.
  // Provider.complete has no max-output option, so enforce the acceptance bound
  // locally as well as requesting it in the prompt.
  if (summaryWithFiles.length > 32_768 || estimateTextTokens(summaryWithFiles, providerId) > maxOutputTokens) {
    return { compacted: false, reason: "compactor summary exceeds output budget", degradation };
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
    degradation,
    // Same payload the resident message carries (minus the envelope prefix —
    // session replay adds its own "Previous conversation summary:" header), so
    // the persisted checkpoint matches the in-memory state, file blocks included.
    summary: summaryWithFiles,
    messages: compacted,
  };
}

/** Fit the summarization input under the model's window by dropping complete
 * assistant/tool groups. Exported for regression tests only — callers use
 * compactWithLLM. */
export function fitSummaryInput(
  messages: Message[], prompt: string, maxTokens: number, providerId: string,
): { historyText: string; degradation?: string } | undefined {
  // Trim complete assistant/tool groups, never prior summaries, user constraints,
  // or runtime context. If protected content alone exceeds the budget, fail
  // explicitly and let the caller choose a fallback; do not call on empty input.
  // Group by pending tool-call ids, not adjacency: an interleaved meta reminder
  // between a call and its result must not split the pair — otherwise trimming
  // can drop the call while keeping an orphan `TOOL_RESULT[tool]` line that has
  // lost its name and provenance.
  const groups: Message[][] = [];
  const groupByCallId = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.role === "tool") {
      const group = groupByCallId.get(message.toolCallId);
      if (group) {
        group.push(message);
        continue;
      }
    }
    const group = [message];
    groups.push(group);
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) groupByCallId.set(toolCall.id, group);
    }
  }
  let dropped = 0;
  while (true) {
    const degradation = dropped
      ? `[Compaction input degraded: omitted ${dropped} older assistant/tool groups to fit the model window.]`
      : undefined;
    const historyText = [degradation, serializeHistoryAsText(groups.flat())].filter(Boolean).join("\n\n");
    // Measure the actual serialized payload (including labels and prompt), with
    // the same conservative first-turn safety margin as the context budget.
    const tokens = Math.ceil((estimateTextTokens(prompt, providerId)
      + estimateTextTokens(historyText, providerId) + 32) * 1.25);
    if (tokens <= maxTokens && groups.length > 0) return { historyText, degradation };
    const removable = groups.findIndex((group) => group.every((m) => m.role === "assistant" || m.role === "tool"));
    if (removable < 0) return undefined;
    groups.splice(removable, 1);
    dropped++;
  }
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
        lines.push(`TOOL_RESULT[${name}]: ${msg.content}`);
        break;
      }
      case "meta":
        // Expired runtime reminders remain in history but are no longer model
        // context. Prior summaries have already been folded into user input.
        if (msg.includeInLlm !== false) lines.push(`CONTEXT: ${msg.content}`);
        break;
      default:
        lines.push(`CONTEXT: ${messageText(msg)}`);
        break;
    }
  }

  return lines.join("\n\n");
}

function summarizeToolCallArgs(tc: ToolCall): string {
  return tc.arguments || "{}";
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
