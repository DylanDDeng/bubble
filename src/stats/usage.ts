import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBubbleHome } from "../bubble-home.js";
import { calculateUsageCost } from "../model-pricing.js";
import type { PricingCurrency } from "../model-pricing.js";
import { decodeModel } from "../provider-registry.js";
import type { SessionMetadata } from "../session-types.js";
import type { TokenUsage } from "../types.js";

export type StatsRange = "7d" | "30d";

export interface DailyUsage {
  date: string;
  active: boolean;
  tokens: number;
  hasPreciseUsage: boolean;
}

export interface HeatmapColumn {
  label: string;
  cells: Array<DailyUsage | undefined>;
}

export interface ModelUsageStats {
  model: string;
  displayName: string;
  providerId?: string;
  modelId?: string;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost?: number;
  costCurrency?: PricingCurrency;
}

export interface UsageStats {
  range: StatsRange;
  days: number;
  startDate: string;
  endDate: string;
  daily: DailyUsage[];
  heatmap: HeatmapColumn[];
  models: ModelUsageStats[];
  totalTokens: number;
  trackedCosts?: Partial<Record<PricingCurrency, number>>;
  trackedCost?: number;
  trackedCostCurrency?: PricingCurrency;
  activeDays: number;
  sessionsScanned: number;
  sessionsWithoutTokenData: number;
}

export interface UsageStatsBundle {
  generatedAt: Date;
  ranges: Record<StatsRange, UsageStats>;
}

interface RangeAccumulator {
  range: StatsRange;
  days: number;
  start: Date;
  end: Date;
  daily: Map<string, DailyUsage>;
  modelUsage: Map<string, ModelUsageStats>;
  sessionsScanned: number;
  sessionsWithoutTokenData: number;
}

interface ParsedSessionEntry {
  type?: string;
  timestamp?: number | string;
  metadata?: SessionMetadata;
  kind?: string;
  value?: string;
  message?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface RangeSessionFlags {
  active: boolean;
  hasUsage: boolean;
}

const RANGES: Array<{ range: StatsRange; days: number }> = [
  { range: "7d", days: 7 },
  { range: "30d", days: 30 },
];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const EMPTY_CELL = " ";
const HEAT_LEVELS = [".", "o", "O", "@"];
const MAX_MODEL_ROWS = 5;

export function collectUsageStatsBundle(options: {
  now?: Date;
  sessionsRoot?: string;
} = {}): UsageStatsBundle {
  const now = options.now ?? new Date();
  const sessionsRoot = options.sessionsRoot ?? join(getBubbleHome(), "sessions");
  const accumulators = Object.fromEntries(
    RANGES.map(({ range, days }) => [range, createAccumulator(range, days, now)]),
  ) as Record<StatsRange, RangeAccumulator>;

  for (const file of listSessionFiles(sessionsRoot)) {
    processSessionFile(file, accumulators);
  }

  return {
    generatedAt: now,
    ranges: {
      "7d": finalizeAccumulator(accumulators["7d"]),
      "30d": finalizeAccumulator(accumulators["30d"]),
    },
  };
}

export function formatStatsText(bundle: UsageStatsBundle, range: StatsRange = "30d", width = 78): string {
  const stats = bundle.ranges[range];
  return [
    `Bubble Stats · ${rangeLabel(range)}`,
    "",
    formatStatsPanelBody(stats, width),
  ].join("\n");
}

export function formatStatsPanelBody(stats: UsageStats, width = 72): string {
  const bodyWidth = Math.max(48, width);
  const lines: string[] = [];

  lines.push("Activity");
  lines.push(...formatHeatmapLines(stats));
  lines.push("");
  lines.push("Model usage");
  lines.push(...formatModelUsageLines(stats, bodyWidth));
  lines.push("");
  lines.push("Summary");
  lines.push(...formatSummaryLines(stats, bodyWidth));

  return lines.join("\n");
}

export function rangeLabel(range: StatsRange): string {
  return range === "7d" ? "Last 7 days" : "Last 30 days";
}

export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000, 1)}B`;
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${trimFixed(value / 1_000, 1)}k`;
  return String(Math.round(value));
}

export function formatCurrency(value: number): string {
  return formatCurrencyFor(value, "USD");
}

function formatCurrencyFor(value: number, currency: PricingCurrency): string {
  const amount = value >= 1
    ? value.toFixed(2)
    : value >= 0.01
      ? value.toFixed(3)
      : value.toFixed(4);
  return currency === "USD" ? `$${amount}` : `CNY ${amount}`;
}

function createAccumulator(range: StatsRange, days: number, now: Date): RangeAccumulator {
  const end = startOfLocalDay(now);
  const start = addDays(end, -(days - 1));
  const daily = new Map<string, DailyUsage>();
  for (let i = 0; i < days; i += 1) {
    const date = localDateKey(addDays(start, i));
    daily.set(date, {
      date,
      active: false,
      tokens: 0,
      hasPreciseUsage: false,
    });
  }

  return {
    range,
    days,
    start,
    end,
    daily,
    modelUsage: new Map(),
    sessionsScanned: 0,
    sessionsWithoutTokenData: 0,
  };
}

function processSessionFile(file: string, accumulators: Record<StatsRange, RangeAccumulator>) {
  let entries: ParsedSessionEntry[];
  try {
    const content = readFileSync(file, "utf-8");
    entries = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ParsedSessionEntry);
  } catch {
    return;
  }

  const sessionFlags = Object.fromEntries(
    RANGES.map(({ range }) => [range, { active: false, hasUsage: false }]),
  ) as Record<StatsRange, RangeSessionFlags>;
  let currentModel: string | undefined;

  for (const entry of entries) {
    if (entry.type === "metadata") {
      currentModel = entry.metadata?.model ?? currentModel;
      continue;
    }
    if (entry.type === "marker" && entry.kind === "model_switch") {
      currentModel = typeof entry.value === "string" ? entry.value : currentModel;
    }

    const timestamp = normalizeTimestamp(entry.timestamp);
    if (!timestamp) continue;

    const message = assistantPayload(entry);
    const model = resolveEntryModel(entry, message, currentModel);
    const usage = message ? normalizeUsage(message.usage) : undefined;

    for (const accumulator of Object.values(accumulators)) {
      if (!isWithinRange(timestamp, accumulator)) continue;
      const flags = sessionFlags[accumulator.range];
      flags.active = true;
      markActiveDay(accumulator, timestamp, usage);
      if (message && usage && model) {
        flags.hasUsage = true;
        addModelUsage(accumulator, model, message, usage);
      }
    }
  }

  for (const accumulator of Object.values(accumulators)) {
    const flags = sessionFlags[accumulator.range];
    if (!flags.active) continue;
    accumulator.sessionsScanned += 1;
    if (!flags.hasUsage) accumulator.sessionsWithoutTokenData += 1;
  }
}

function finalizeAccumulator(accumulator: RangeAccumulator): UsageStats {
  const daily = [...accumulator.daily.values()];
  const models = [...accumulator.modelUsage.values()]
    .filter((model) => model.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const totalTokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const trackedCosts = aggregateCosts(models);
  const trackedCostEntries = trackedCosts
    ? (Object.entries(trackedCosts) as Array<[PricingCurrency, number]>)
    : [];
  const trackedCostEntry = trackedCostEntries.length === 1 ? trackedCostEntries[0] : undefined;
  return {
    range: accumulator.range,
    days: accumulator.days,
    startDate: localDateKey(accumulator.start),
    endDate: localDateKey(accumulator.end),
    daily,
    heatmap: buildHeatmap(daily),
    models,
    totalTokens,
    trackedCosts,
    trackedCost: trackedCostEntry ? trackedCostEntry[1] : undefined,
    trackedCostCurrency: trackedCostEntry ? trackedCostEntry[0] : undefined,
    activeDays: daily.filter((day) => day.active).length,
    sessionsScanned: accumulator.sessionsScanned,
    sessionsWithoutTokenData: accumulator.sessionsWithoutTokenData,
  };
}

function addModelUsage(
  accumulator: RangeAccumulator,
  model: string,
  message: Record<string, unknown>,
  usage: TokenUsage,
) {
  const decoded = decodeModel(model);
  const providerId = typeof message.providerId === "string" ? message.providerId : decoded.providerId;
  const modelId = typeof message.modelId === "string" ? message.modelId : decoded.modelId;
  const key = providerId ? `${providerId}:${modelId}` : model;
  const existing = accumulator.modelUsage.get(key) ?? {
    model: key,
    displayName: key,
    providerId,
    modelId,
    turns: 0,
    promptTokens: 0,
    completionTokens: 0,
    promptCacheHitTokens: 0,
    promptCacheMissTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };

  existing.turns += 1;
  existing.promptTokens += usage.promptTokens;
  existing.completionTokens += usage.completionTokens;
  existing.promptCacheHitTokens += usage.promptCacheHitTokens ?? 0;
  existing.promptCacheMissTokens += usage.promptCacheMissTokens ?? 0;
  existing.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  existing.reasoningTokens += usage.reasoningTokens ?? 0;
  existing.totalTokens += tokenTotal(usage);

  if (providerId && modelId) {
    const cost = calculateUsageCost(providerId, modelId, usage);
    if (cost) {
      existing.cost = (existing.cost ?? 0) + cost.cost;
      existing.costCurrency = cost.currency;
    }
  }

  accumulator.modelUsage.set(key, existing);
}

function markActiveDay(accumulator: RangeAccumulator, timestamp: Date, usage?: TokenUsage) {
  const key = localDateKey(timestamp);
  const day = accumulator.daily.get(key);
  if (!day) return;
  day.active = true;
  if (usage) {
    day.hasPreciseUsage = true;
    day.tokens += tokenTotal(usage);
  }
}

function buildHeatmap(daily: DailyUsage[]): HeatmapColumn[] {
  const byWeek = new Map<string, HeatmapColumn>();
  for (const day of daily) {
    const date = parseLocalDate(day.date);
    const weekStart = mondayOfWeek(date);
    const weekKey = localDateKey(weekStart);
    if (!byWeek.has(weekKey)) {
      byWeek.set(weekKey, {
        label: formatMonthDay(weekStart),
        cells: Array.from({ length: 7 }, () => undefined),
      });
    }
    byWeek.get(weekKey)!.cells[weekdayIndex(date)] = day;
  }
  return [...byWeek.values()];
}

function formatHeatmapLines(stats: UsageStats): string[] {
  if (stats.activeDays === 0) return ["  No activity in this range."];

  const columns = stats.heatmap;
  const maxTokens = Math.max(0, ...stats.daily.map((day) => day.tokens));
  const lines = [
    `     ${columns.map((column) => column.label.padStart(5, " ")).join(" ")}`,
  ];
  for (let row = 0; row < 7; row += 1) {
    const cells = columns.map((column) => {
      const day = column.cells[row];
      return heatmapCell(day, maxTokens).padStart(5, " ");
    });
    lines.push(`${WEEKDAY_LABELS[row]}  ${cells.join(" ")}`);
  }
  lines.push(`     Less ${HEAT_LEVELS.join(" ")} More`);
  return lines;
}

function formatModelUsageLines(stats: UsageStats, width: number): string[] {
  if (stats.models.length === 0) {
    return ["  No precise token usage recorded yet."];
  }

  const showCost = stats.models.some((model) => model.cost !== undefined);
  const overhead = showCost ? 29 : 21;
  const minBarWidth = 6;
  const labelWidth = Math.max(
    12,
    Math.min(28, Math.floor((width - overhead - minBarWidth) * 0.65)),
  );
  const barWidth = Math.max(
    minBarWidth,
    Math.min(20, width - labelWidth - overhead),
  );
  const rows = stats.models.slice(0, MAX_MODEL_ROWS).map((model) => {
    const percent = stats.totalTokens > 0 ? model.totalTokens / stats.totalTokens : 0;
    const bar = usageBar(percent, barWidth);
    const percentText = `${Math.round(percent * 100)}%`.padStart(4, " ");
    const tokenText = formatCompactNumber(model.totalTokens).padStart(6, " ");
    const turnsText = `${model.turns}t`.padStart(4, " ");
    const costText = showCost
      ? ` ${(model.cost !== undefined ? formatCurrencyFor(model.cost, model.costCurrency ?? "USD") : "").padStart(7, " ")}`
      : "";
    return `  ${truncate(model.displayName, labelWidth).padEnd(labelWidth, " ")} ${bar} ${percentText} ${tokenText} ${turnsText}${costText}`.trimEnd();
  });
  if (stats.models.length > MAX_MODEL_ROWS) {
    rows.push(`  ...and ${stats.models.length - MAX_MODEL_ROWS} more model${stats.models.length - MAX_MODEL_ROWS === 1 ? "" : "s"}`);
  }
  return rows;
}

function formatSummaryLines(stats: UsageStats, width: number): string[] {
  const favorite = stats.models[0]?.displayName;
  const lines = [
    `  Active days ${stats.activeDays}/${stats.days} · Total ${formatCompactNumber(stats.totalTokens)} tokens`,
  ];
  if (favorite) {
    lines.push(`  Favorite model ${truncate(favorite, Math.max(12, width - 17))}`);
  }
  const cacheSummary = formatCacheSummary(stats.models);
  if (cacheSummary) lines.push(`  ${cacheSummary}`);
  const trackedCostText = formatTrackedCosts(stats);
  if (trackedCostText) lines.push(`  Tracked cost ${trackedCostText}`);
  lines.push(`  Sessions scanned ${stats.sessionsScanned}`);
  if (stats.sessionsWithoutTokenData > 0) {
    lines.push(`  Sessions without token data ${stats.sessionsWithoutTokenData}`);
  }
  return lines;
}

function formatCacheSummary(models: ModelUsageStats[]): string | undefined {
  const read = models.reduce((sum, model) => sum + model.promptCacheHitTokens, 0);
  const create = models.reduce((sum, model) => sum + model.cacheCreationTokens, 0);
  const missWithCreate = models.reduce((sum, model) => sum + model.promptCacheMissTokens, 0);
  const miss = Math.max(0, missWithCreate - create);
  const observed = read + create + miss;
  if (observed === 0) return undefined;
  const hitRate = Math.round((read / observed) * 100);
  return `Prompt cache ${formatCompactNumber(read)} read · ${formatCompactNumber(create)} create · ${formatCompactNumber(miss)} miss · ${hitRate}% hit`;
}

function aggregateCosts(models: ModelUsageStats[]): Partial<Record<PricingCurrency, number>> | undefined {
  const totals: Partial<Record<PricingCurrency, number>> = {};
  for (const model of models) {
    if (model.cost === undefined) continue;
    const currency = model.costCurrency ?? "USD";
    totals[currency] = (totals[currency] ?? 0) + model.cost;
  }
  return Object.keys(totals).length > 0 ? totals : undefined;
}

function formatTrackedCosts(stats: UsageStats): string | undefined {
  if (stats.trackedCosts) {
    const parts = (Object.entries(stats.trackedCosts) as Array<[PricingCurrency, number]>)
      .filter(([, value]) => value > 0)
      .map(([currency, value]) => formatCurrencyFor(value, currency));
    return parts.length > 0 ? parts.join(" + ") : undefined;
  }
  if (stats.trackedCost !== undefined) {
    return formatCurrencyFor(stats.trackedCost, stats.trackedCostCurrency ?? "USD");
  }
  return undefined;
}

function heatmapCell(day: DailyUsage | undefined, maxTokens: number): string {
  if (!day) return " ";
  if (!day.active) return EMPTY_CELL;
  if (!day.hasPreciseUsage || maxTokens <= 0) return HEAT_LEVELS[0];
  const ratio = day.tokens / maxTokens;
  if (ratio <= 0.25) return HEAT_LEVELS[0];
  if (ratio <= 0.5) return HEAT_LEVELS[1];
  if (ratio <= 0.75) return HEAT_LEVELS[2];
  return HEAT_LEVELS[3];
}

function usageBar(percent: number, width: number): string {
  if (width <= 0) return "";
  let filled = Math.round(percent * width);
  if (percent > 0 && filled === 0) filled = 1;
  filled = Math.max(0, Math.min(width, filled));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function assistantPayload(entry: ParsedSessionEntry): Record<string, unknown> | undefined {
  if (entry.type === "assistant_message") return entry.message;
  if (entry.type === "message" && entry.data?.role === "assistant") return entry.data;
  return undefined;
}

function resolveEntryModel(
  entry: ParsedSessionEntry,
  message: Record<string, unknown> | undefined,
  currentModel: string | undefined,
): string | undefined {
  const model = message?.model ?? (entry as Record<string, unknown>).model ?? currentModel;
  return typeof model === "string" && model.trim() ? model : undefined;
}

function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const rawInputTokens = numberValue(value.input_tokens);
  const cacheReadTokens = numberValue(value.promptCacheHitTokens) ?? numberValue(value.cache_read_input_tokens);
  const cacheCreationTokens = numberValue(value.cacheCreationTokens) ?? numberValue(value.cache_creation_input_tokens);
  const promptTokens = numberValue(value.promptTokens)
    ?? (rawInputTokens !== undefined
      ? rawInputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
      : undefined);
  const completionTokens = numberValue(value.completionTokens) ?? numberValue(value.output_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return {
    promptTokens,
    completionTokens,
    promptCacheHitTokens: cacheReadTokens,
    promptCacheMissTokens: numberValue(value.promptCacheMissTokens)
      ?? numberValue(value.cache_miss_input_tokens)
      ?? (rawInputTokens !== undefined ? rawInputTokens + (cacheCreationTokens ?? 0) : undefined),
    cacheCreationTokens,
    reasoningTokens: numberValue(value.reasoningTokens),
    totalTokens: numberValue(value.totalTokens) ?? numberValue(value.total_tokens),
  };
}

function tokenTotal(usage: TokenUsage): number {
  return usage.totalTokens ?? (usage.promptTokens + usage.completionTokens);
}

function listSessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const projectDir of safeReadDir(root)) {
    const projectPath = join(root, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of safeReadDir(projectPath)) {
      if (file.endsWith(".jsonl")) files.push(join(projectPath, file));
    }
  }
  return files;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function normalizeTimestamp(value: number | string | undefined): Date | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function isWithinRange(date: Date, accumulator: RangeAccumulator): boolean {
  const day = startOfLocalDay(date);
  return day.getTime() >= accumulator.start.getTime() && day.getTime() <= accumulator.end.getTime();
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseLocalDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatMonthDay(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function mondayOfWeek(date: Date): Date {
  return addDays(startOfLocalDay(date), -weekdayIndex(date));
}

function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function trimFixed(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
