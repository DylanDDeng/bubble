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

export const LLM_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. The conversation below is about to be removed from the model's context and replaced by your summary. Another LLM will resume the task seeing only your summary, the user's original instruction, and the most recent messages. Anything you leave out is gone.

Write a handoff summary that lets it continue without repeating the investigation. Cover:
- Goal and constraints: what the user wants, in their terms. Explicit requirements, preferences, and anything they ruled out. Quote exact wording where precision matters.
- Decisions made and why, including approaches that were tried and rejected, so they are not retried.
- Current state: what is done and verified, what is in progress, what is broken or still unverified. Keep verified facts distinct from assumptions.
- Specifics needed to continue: file paths, identifiers, commands, error messages, config values, ids, URLs. Exact, never paraphrased.
- Next steps in order, starting with the immediate one.

Length follows content: as long as needed to preserve the above, and no longer. Spend words on what cannot be cheaply re-derived (decisions, constraints, findings). Do not reproduce file contents or tool output that can simply be read again, and do not narrate the conversation turn by turn. The lists of files read and modified are recorded separately; name only the files that matter for the next steps.

Carry forward every fact from prior summaries and the original user constraints. If the input says parts of the history were omitted, say so explicitly.`;

export const LLM_SUMMARY_PREFIX = `Another language model previously worked on this task and produced this handoff summary. Build on what's already done; avoid re-running the same investigation. Summary:`;

export interface LLMCompactOptions {
  provider: Provider;
  modelId: string;
  /** Total estimated request ceiling, including the compaction prompt. */
  maxInputTokens?: number;
  providerId?: string;
  contextWindow?: number;
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
  // getMaxInputTokens already reserves the window's answer space, which is what
  // the summary is written into. No fixed output ceiling: summary length is
  // judged against what it replaces, below, and by the caller's before/after
  // budget comparison.
  const maxInputTokens = Math.min(options.maxInputTokens ?? Infinity, getMaxInputTokens(contextWindow) ?? 0);
  if (![contextWindow, maxInputTokens].every((n) => Number.isFinite(n) && n > 0)) {
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

  const prompt = LLM_COMPACTION_PROMPT;
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

  // The only meaningful length bound is relative: a summary that is not shorter
  // than the history it replaces (a model echoing its input) compacts nothing.
  // Judge the model's prose alone — the deterministic file lists are not its
  // output — and reject rather than clip decisions/constraints out of it.
  if (estimateTextTokens(summaryText, providerId) >= estimateTextTokens(serializeHistoryAsText(toSummarize), providerId)) {
    return { compacted: false, reason: "compactor summary is not shorter than the history it replaces", degradation };
  }
  if (degradation) summaryText = `${degradation}\n\n${summaryText}`;
  const summaryWithFiles = appendFileBlocks(summaryText, fileOps);

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

/** Fit the summarization input under the model's window, degrading breadth-first:
 *  1. everything verbatim;
 *  2. cap tool payloads (results and tool-call arguments alike) at the LARGEST
 *     common length that fits — short payloads such as paths and commands stay
 *     whole, only long ones lose their middle, and every group still informs
 *     the summary;
 *  3. only when even empty payloads do not fit, drop the oldest assistant/tool
 *     group and search again, so what survives is as complete as the room allows.
 * The cap is derived from the budget, never a fixed size. Prior summaries, user
 * constraints and runtime context are never trimmed; if they alone exceed the
 * budget this fails explicitly and the caller chooses a fallback.
 * `degradation` is the durable part: whole steps the summary never saw. Trimmed
 * middles are stated in the input only — that loss is inherent to summarizing.
 * Exported for regression tests only — callers use compactWithLLM. */
export function fitSummaryInput(
  messages: Message[], prompt: string, maxTokens: number, providerId: string,
): { historyText: string; degradation?: string } | undefined {
  // Group by pending tool-call ids, not adjacency: an interleaved meta reminder
  // between a call and its result must not split the pair — otherwise dropping
  // can remove the call while keeping an orphan `TOOL_RESULT[tool]` line that
  // has lost its name and provenance.
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

  const promptTokens = estimateTextTokens(prompt, providerId);
  const render = (cap: number | undefined, dropped: number) => {
    const degradation = dropped
      ? `[Compaction input degraded: omitted ${dropped} older assistant/tool groups to fit the model window.]`
      : undefined;
    const trimNote = cap !== undefined
      ? `[Tool results and tool-call arguments longer than ${cap} characters show only their head and tail.]`
      : undefined;
    const historyText = [degradation, trimNote, serializeHistoryAsText(groups.flat(), cap)].filter(Boolean).join("\n\n");
    // Measure the actual serialized payload (including labels and prompt), with
    // the same conservative first-turn safety margin as the context budget.
    const tokens = Math.ceil((promptTokens + estimateTextTokens(historyText, providerId) + 32) * 1.25);
    return { fits: tokens <= maxTokens, fitted: { historyText, degradation } };
  };

  for (let dropped = 0; groups.length > 0; dropped++) {
    // Empty payloads are the cheapest probe and the floor of what trimming can reach.
    let best = render(0, dropped);
    if (best.fits) {
      const whole = render(undefined, dropped);
      if (whole.fits) return whole.fitted;
      let low = 0;
      let high = longestPayload(groups);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const probe = render(middle, dropped);
        if (probe.fits) { low = middle; best = probe; } else high = middle - 1;
      }
      return best.fitted;
    }
    const removable = groups.findIndex((group) => group.every((m) => m.role === "assistant" || m.role === "tool"));
    if (removable < 0) return undefined;
    groups.splice(removable, 1);
  }
  return undefined;
}

function longestPayload(groups: Message[][]): number {
  let longest = 0;
  for (const group of groups) {
    for (const message of group) {
      if (message.role === "tool") longest = Math.max(longest, message.content.length);
      else if (message.role === "assistant") {
        for (const toolCall of message.toolCalls ?? []) longest = Math.max(longest, (toolCall.arguments || "").length);
      }
    }
  }
  return longest;
}

/** Keep the head and tail of a payload longer than `cap`; the marker states
 * exactly how much is missing so the summarizer never mistakes it for the whole.
 * Exported for regression tests only. */
export function capPayload(text: string, cap: number | undefined): string {
  if (cap === undefined || text.length <= cap) return text;
  let headEnd = Math.ceil(cap / 2);
  let tailStart = text.length - (cap - headEnd);
  // Never cut a surrogate pair in half: a lone surrogate is invalid Unicode that
  // some provider endpoints reject outright.
  if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd--;
  if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart++;
  const marker = `[... ${tailStart - headEnd} of ${text.length} characters omitted ...]`;
  if (headEnd + marker.length + (text.length - tailStart) >= text.length) return text;
  return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function serializeHistoryAsText(messages: Message[], payloadCap?: number): string {
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
            lines.push(`TOOL_CALL[${tc.name}]: ${capPayload(summarizeToolCallArgs(tc), payloadCap)}`);
          }
        }
        break;
      }
      case "tool": {
        const name = toolNameByCallId.get(msg.toolCallId) ?? "tool";
        lines.push(`TOOL_RESULT[${name}]: ${capPayload(msg.content, payloadCap)}`);
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
