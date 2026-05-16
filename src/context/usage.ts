import { getModelContextWindow } from "../model-catalog.js";
import { formatSkillsPrompt } from "../skills/format.js";
import type { SkillSummary } from "../skills/types.js";
import type { Message, ToolRegistryEntry } from "../types.js";
import { buildDeferredToolsReminder } from "../prompt/reminders.js";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
  MIN_WINDOW_FOR_RESERVE,
  OUTPUT_RESERVE_TOKENS,
} from "./budget.js";

export interface ContextUsageBucket {
  label: string;
  tokens: number;
  detail?: string;
}

export interface ContextUsageSnapshot {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  usedTokens: number;
  freeTokens?: number;
  buckets: {
    systemPrompt: ContextUsageBucket;
    tools: ContextUsageBucket;
    skills: ContextUsageBucket;
    deferredTools: ContextUsageBucket;
    other: ContextUsageBucket;
  };
  toolCount: number;
  deferredToolCount: number;
  skillCount: number;
  messageCount: number;
}

export function buildContextUsageSnapshot(input: {
  providerId: string;
  modelId: string;
  messages: Message[];
  toolEntries: ToolRegistryEntry[];
  deferredToolEntries?: ToolRegistryEntry[];
  skills: SkillSummary[];
}): ContextUsageSnapshot {
  const systemMessages = input.messages.filter((message) => message.role === "system");
  const otherMessages = input.messages.filter((message) => message.role !== "system");
  const deferredToolEntries = input.deferredToolEntries ?? [];
  const systemContent = systemMessages.map((message) => message.content).join("\n\n");
  const skillsPrompt = formatSkillsPrompt(input.skills);
  const skillsInSystemPrompt = !!skillsPrompt && systemContent.includes(skillsPrompt);
  const skillsTokens = skillsInSystemPrompt ? estimateTextTokens(skillsPrompt) : 0;
  const systemPromptTokens = Math.max(0, estimateTextTokens(systemContent) - skillsTokens);
  const toolsTokens = estimateToolEntriesTokens(input.toolEntries);
  const deferredToolsTokens = estimateDeferredToolsReminderTokens(deferredToolEntries);
  const rawOtherTokens = otherMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const otherTokens = Math.max(0, rawOtherTokens - deferredToolsTokens);
  const usedTokens = systemPromptTokens + toolsTokens + skillsTokens + deferredToolsTokens + otherTokens;
  const contextWindow = getModelContextWindow(input.providerId, input.modelId);

  return {
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindow,
    usedTokens,
    freeTokens: contextWindow === undefined ? undefined : Math.max(0, contextWindow - usedTokens),
    buckets: {
      systemPrompt: {
        label: "System prompt",
        tokens: systemPromptTokens,
        detail: systemMessages.length > 0 ? `${systemMessages.length} system message${systemMessages.length === 1 ? "" : "s"}` : "none",
      },
      tools: {
        label: "Tools",
        tokens: toolsTokens,
        detail: input.toolEntries.length > 0 ? `${input.toolEntries.length} active schema${input.toolEntries.length === 1 ? "" : "s"}` : "none",
      },
      skills: {
        label: "Skills",
        tokens: skillsTokens,
        detail: skillsInSystemPrompt && input.skills.length > 0 ? `${input.skills.length} advertised skill${input.skills.length === 1 ? "" : "s"}` : "none in current prompt",
      },
      deferredTools: {
        label: "Deferred/MCP",
        tokens: deferredToolsTokens,
        detail: deferredToolEntries.length > 0
          ? `${deferredToolEntries.length} deferred tool name${deferredToolEntries.length === 1 ? "" : "s"} in reminder`
          : "none",
      },
      other: {
        label: "Other",
        tokens: otherTokens,
        detail: otherMessages.length > 0 ? `${otherMessages.length} conversation/meta/tool message${otherMessages.length === 1 ? "" : "s"}` : "none",
      },
    },
    toolCount: input.toolEntries.length,
    deferredToolCount: deferredToolEntries.length,
    skillCount: skillsInSystemPrompt ? input.skills.length : 0,
    messageCount: input.messages.length,
  };
}

export function formatContextUsage(snapshot: ContextUsageSnapshot): string {
  const freeTokens = snapshot.freeTokens ?? 0;
  const rows = [
    { key: "system", marker: "█", color: ANSI_ORANGE, bucket: snapshot.buckets.systemPrompt },
    { key: "tools", marker: "▓", color: ANSI_TEAL, bucket: snapshot.buckets.tools },
    { key: "skills", marker: "▒", color: ANSI_PURPLE, bucket: snapshot.buckets.skills },
    { key: "deferred", marker: "◆", color: ANSI_BLUE, bucket: snapshot.buckets.deferredTools },
    { key: "other", marker: "▪", color: ANSI_GRAY, bucket: snapshot.buckets.other },
  ];
  const freeRow = {
    key: "free",
    marker: "░",
    color: ANSI_DARK_GRAY,
    bucket: {
      label: "Free space",
      tokens: freeTokens,
      detail: snapshot.freeTokens === undefined ? "unknown window" : "available before context limit",
    },
  };
  const barRows = snapshot.contextWindow === undefined ? rows : [...rows, freeRow];
  const barTotal = snapshot.contextWindow ?? Math.max(1, snapshot.usedTokens);
  const compactAt = snapshot.contextWindow === undefined
    ? "unknown"
    : formatTokens(compactionThreshold(snapshot.contextWindow));
  const lines = [
    colorize("• Context Usage", ANSI_BOLD),
    `${colorize(snapshot.providerId || "unknown", ANSI_TEAL)}:${snapshot.modelId || "unknown"} · ${formatUsedWindow(snapshot)} · compaction at ${compactAt}`,
    `Free space: ${snapshot.freeTokens === undefined ? "unknown" : colorize(`${formatTokens(snapshot.freeTokens)} (${formatPercent(snapshot.freeTokens, snapshot.contextWindow)})`, ANSI_DARK_GRAY)}`,
    "",
    buildSegmentedBar(barRows, barTotal),
    "",
    colorize("Estimated usage by category", ANSI_BOLD),
    ...rows.map((row) => formatBucket(row.marker, row.bucket, snapshot.contextWindow)),
    formatBucket(freeRow.marker, freeRow.bucket, snapshot.contextWindow),
    "",
    "Note: estimates include resident messages and active tool schemas; provider tokenization and hidden overhead can differ.",
  ];

  return lines.join("\n");
}

function estimateToolEntriesTokens(entries: ToolRegistryEntry[]): number {
  return entries.reduce((sum, entry) => {
    const payload = JSON.stringify({
      name: entry.name,
      description: entry.description,
      parameters: entry.parameters,
    });
    return sum + estimateTextTokens(payload) + 8;
  }, 0);
}

function estimateDeferredToolsReminderTokens(entries: ToolRegistryEntry[]): number {
  if (entries.length === 0) return 0;
  return estimateTextTokens(buildDeferredToolsReminder(entries.map((entry) => entry.name)));
}

function buildSegmentedBar(
  rows: Array<{ marker: string; color: string; bucket: ContextUsageBucket }>,
  totalTokens: number,
): string {
  const width = 54;
  if (rows.every((row) => row.bucket.tokens <= 0)) {
    return "░".repeat(width);
  }
  const safeTotal = Math.max(1, totalTokens);
  const rawSegments = rows.map((row) => {
    const exact = (Math.max(0, row.bucket.tokens) / safeTotal) * width;
    const minWidth = row.marker !== "░" && row.bucket.tokens > 0 ? 1 : 0;
    return { ...row, exact, width: minWidth };
  });
  let assigned = rawSegments.reduce((sum, segment) => sum + segment.width, 0);

  while (assigned < width && rawSegments.length > 0) {
    const segment = rawSegments.reduce((best, item) => {
      const itemDeficit = item.exact - item.width;
      const bestDeficit = best.exact - best.width;
      return itemDeficit > bestDeficit ? item : best;
    }, rawSegments[0]);
    segment.width += 1;
    assigned += 1;
  }

  while (assigned > width) {
    const segment = rawSegments
      .filter((item) => item.width > 0)
      .sort((a, b) => b.width - a.width)[0];
    if (!segment) break;
    segment.width -= 1;
    assigned -= 1;
  }

  return rawSegments.map((segment) => colorize(segment.marker.repeat(segment.width), segment.color)).join("");
}

function formatBucket(marker: string, bucket: ContextUsageBucket, contextWindow?: number): string {
  const label = bucket.label.padEnd(13, " ");
  const count = contextWindow === undefined && bucket.label === "Free space"
    ? "unknown".padStart(14, " ")
    : formatTokens(bucket.tokens).padStart(14, " ");
  const percent = contextWindow === undefined ? "" : ` ${formatPercent(bucket.tokens, contextWindow).padStart(7, " ")}`;
  const color = colorForLabel(bucket.label);
  return `${colorize(marker, color)} ${colorize(label, color)} ${count}${percent}  ${bucket.detail ?? "unknown"}`;
}

function formatPercent(tokens: number, contextWindow?: number): string {
  if (!contextWindow || contextWindow <= 0) return "";
  const percent = (tokens / contextWindow) * 100;
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

function formatUsedWindow(snapshot: ContextUsageSnapshot): string {
  if (snapshot.contextWindow === undefined) return `~${formatTokens(snapshot.usedTokens)} used`;
  return `${formatTokenNumber(snapshot.usedTokens)}/${formatTokenNumber(snapshot.contextWindow)} tokens (${formatPercent(snapshot.usedTokens, snapshot.contextWindow)})`;
}

function compactionThreshold(contextWindow: number): number {
  if (contextWindow >= MIN_WINDOW_FOR_RESERVE) {
    return Math.max(0, contextWindow - OUTPUT_RESERVE_TOKENS - AUTOCOMPACT_BUFFER_TOKENS);
  }
  return Math.floor(contextWindow * 0.75);
}

function formatTokens(count: number): string {
  return `${formatTokenNumber(count)} tokens`;
}

function formatTokenNumber(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 1_000_000) return `${formatFixed(count / 1000)}K`;
  return `${formatFixed(count / 1_000_000)}M`;
}

function formatFixed(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_ORANGE = "\u001b[38;5;208m";
const ANSI_TEAL = "\u001b[38;5;73m";
const ANSI_PURPLE = "\u001b[38;5;141m";
const ANSI_BLUE = "\u001b[38;5;75m";
const ANSI_GRAY = "\u001b[38;5;245m";
const ANSI_DARK_GRAY = "\u001b[38;5;240m";

function colorize(text: string, color: string): string {
  if (!text) return text;
  return `${color}${text}${ANSI_RESET}`;
}

function colorForLabel(label: string): string {
  if (label === "System prompt") return ANSI_ORANGE;
  if (label === "Tools") return ANSI_TEAL;
  if (label === "Skills") return ANSI_PURPLE;
  if (label === "Deferred/MCP") return ANSI_BLUE;
  if (label === "Free space") return ANSI_DARK_GRAY;
  return ANSI_GRAY;
}
