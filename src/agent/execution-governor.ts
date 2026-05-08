import { analyzeToolIntent } from "./tool-intent.js";
import type { ParsedToolCall, ToolRegistryEntry, ToolResult, ToolResultMetadata } from "../types.js";
import type { TaskType } from "./task-classifier.js";
import { buildExplorationFreezeReminder, buildInvestigationReminder, buildLoopWarningReminder, buildSearchFreezeReminder } from "../prompt/reminders.js";

interface GovernorBudget {
  softTotalSteps: number;
  softSearchSteps: number;
  softReadSteps: number;
  maxExplorationStepsWithoutWrite: number;
  maxNoProgressReadExactRepeats: number;
  maxNoProgressExactRepeats: number;
  maxNoProgressFamilyRepeats: number;
  warningFamilyRepeats: number;
}

interface ToolObservation {
  family: ReturnType<typeof analyzeToolIntent>["family"];
  signature?: string;
  familyKey?: string;
  progress: boolean;
}

export interface GovernorDecision {
  blockedResult?: ToolResult;
}

const BUDGETS: Record<TaskType, GovernorBudget> = {
  security_investigation: {
    softTotalSteps: 14,
    softSearchSteps: 6,
    softReadSteps: 8,
    maxExplorationStepsWithoutWrite: 12,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 2,
    maxNoProgressFamilyRepeats: 3,
    warningFamilyRepeats: 2,
  },
  code_search: {
    softTotalSteps: 16,
    softSearchSteps: 8,
    softReadSteps: 10,
    maxExplorationStepsWithoutWrite: 14,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  debugging: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 7,
    maxExplorationStepsWithoutWrite: 10,
    maxNoProgressReadExactRepeats: 1,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  implementation: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 6,
    maxExplorationStepsWithoutWrite: 8,
    maxNoProgressReadExactRepeats: 1,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  code_review: {
    softTotalSteps: 14,
    softSearchSteps: 6,
    softReadSteps: 8,
    maxExplorationStepsWithoutWrite: 12,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  code_explanation: {
    softTotalSteps: 12,
    softSearchSteps: 6,
    softReadSteps: 8,
    maxExplorationStepsWithoutWrite: 12,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  repo_orientation: {
    softTotalSteps: 12,
    softSearchSteps: 6,
    softReadSteps: 8,
    maxExplorationStepsWithoutWrite: 12,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  product_discussion: {
    softTotalSteps: 10,
    softSearchSteps: 4,
    softReadSteps: 4,
    maxExplorationStepsWithoutWrite: 8,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 2,
    maxNoProgressFamilyRepeats: 3,
    warningFamilyRepeats: 2,
  },
  general: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 10,
    maxExplorationStepsWithoutWrite: 14,
    maxNoProgressReadExactRepeats: 2,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
};

const SEARCH_TOOLS_DISABLED = new Set(["grep", "web_search", "web_fetch"]);
const EXPLORATION_TOOLS_DISABLED = new Set(["read", "glob", "grep", "web_search", "web_fetch", "task", "tool_search"]);

type WorkPhase = "explore" | "modify" | "verify";

export class ExecutionGovernor {
  private budget: GovernorBudget;
  private history: ToolObservation[] = [];
  private totalSteps = 0;
  private searchSteps = 0;
  private readSteps = 0;
  private explorationStepsWithoutWrite = 0;
  private searchFrozen = false;
  private explorationFrozen = false;
  private phase: WorkPhase = "explore";
  private codeChanged = false;
  private reminderQueue: string[] = [];
  private warnedFamilies = new Set<string>();
  private softTotalWarned = false;
  private softSearchWarned = false;
  private softReadWarned = false;

  constructor(private taskType: TaskType) {
    this.budget = BUDGETS[taskType];
    if (taskType === "security_investigation") {
      this.reminderQueue.push(buildInvestigationReminder());
    }
  }

  consumePendingReminders(): string[] {
    const reminders = [...this.reminderQueue];
    this.reminderQueue.length = 0;
    return reminders;
  }

  snapshot() {
    return {
      totalSteps: this.totalSteps,
      searchSteps: this.searchSteps,
      readSteps: this.readSteps,
      searchFrozen: this.searchFrozen,
      explorationFrozen: this.explorationFrozen,
      phase: this.phase,
    };
  }

  filterToolDefinitions(toolDefinitions: ToolRegistryEntry[]): ToolRegistryEntry[] {
    let filtered = toolDefinitions;

    if (this.explorationFrozen) {
      filtered = filtered.filter((tool) => !EXPLORATION_TOOLS_DISABLED.has(tool.name));
    } else if (this.searchFrozen) {
      filtered = filtered.filter((tool) => !SEARCH_TOOLS_DISABLED.has(tool.name));
    }

    return filtered;
  }

  beforeToolCall(toolCall: ParsedToolCall): GovernorDecision {
    const intent = analyzeToolIntent(toolCall);

    if (this.explorationFrozen && isExplorationIntent(intent)) {
      return {
        blockedResult: blockedResult(
          "Exploration blocked: this implementation task already has enough context. Use edit/write, verify an existing change, or explain the blocker.",
          "blocked",
          "Exploration frozen because tool calls stopped producing task progress.",
          metadataKindForFamily(intent.family),
        ),
      };
    }

    if (this.isModificationTask() && !this.codeChanged && intent.family === "read") {
      const signature = intent.read?.signature;
      if (signature && this.historyCount((entry) => entry.signature === signature) >= this.budget.maxNoProgressReadExactRepeats) {
        this.enterModifyPhase(`Repeated the same file range without making progress: ${signature}`);
        return {
          blockedResult: blockedResult(
            "Read blocked: this file range was already read. You have enough context to make the requested change; use edit/write now or explain the blocker.",
            "blocked",
            "Repeated identical read before modification.",
            "read",
          ),
        };
      }
    }

    if (intent.family === "search") {
      if (this.searchFrozen) {
        return {
          blockedResult: blockedResult(
            "Search blocked: repeated low-yield searching is now frozen for this task.",
            "blocked",
            "Search frozen due to repeated low-yield searching.",
            "search",
          ),
        };
      }

      const signature = intent.search?.signature;
      const familyKey = intent.search?.familyKey;
      if (signature && this.trailingNoProgressCount((entry) => entry.signature === signature) >= this.budget.maxNoProgressExactRepeats) {
        this.freezeSearch(`Repeated the same search signature without new evidence: ${signature}`);
        return {
          blockedResult: blockedResult(
            "Search blocked: repeated the same search multiple times without new evidence.",
            "blocked",
            "Repeated identical search without progress.",
            "search",
          ),
        };
      }

      if (familyKey) {
        const familyNoProgress = this.trailingNoProgressCount((entry) => entry.familyKey === familyKey);
        if (familyNoProgress >= this.budget.maxNoProgressFamilyRepeats) {
          this.freezeSearch(`Repeated the same search family without new evidence: ${familyKey}`);
          return {
            blockedResult: blockedResult(
              "Search blocked: repeated the same search family without new evidence.",
              "blocked",
              "Repeated similar searches without progress.",
              "search",
            ),
          };
        }
        if (familyNoProgress >= this.budget.warningFamilyRepeats && !this.warnedFamilies.has(familyKey)) {
          this.warnedFamilies.add(familyKey);
          this.reminderQueue.push(buildLoopWarningReminder(
            "Repeated searches are yielding little new evidence. Change your hypothesis, narrow the path, or summarize current findings instead of repeating variants.",
          ));
        }
      }
    }

    this.totalSteps += 1;
    if (intent.family === "search") {
      this.searchSteps += 1;
    }
    if (intent.family === "read") {
      this.readSteps += 1;
    }
    if (isExplorationIntent(intent) && !this.codeChanged) {
      this.explorationStepsWithoutWrite += 1;
    }
    this.maybeWarnOnSoftBudgets(intent.family === "search", intent.family === "read");

    return {};
  }

  afterToolResult(toolCall: ParsedToolCall, result: ToolResult): void {
    const intent = analyzeToolIntent(toolCall);
    const repeatedRead = intent.family === "read"
      && !!intent.read?.signature
      && this.history.some((entry) => entry.signature === intent.read?.signature);
    const progress = inferProgress(intent, result) && !repeatedRead;
    this.history.push({
      family: intent.family,
      signature: intent.search?.signature ?? intent.read?.signature,
      familyKey: intent.search?.familyKey ?? intent.read?.familyKey,
      progress,
    });

    if (isSuccessfulWriteIntent(intent, result)) {
      this.codeChanged = true;
      this.phase = "verify";
      return;
    }

    if (
      this.isModificationTask()
      && !this.codeChanged
      && isExplorationIntent(intent)
      && this.explorationStepsWithoutWrite >= this.budget.maxExplorationStepsWithoutWrite
    ) {
      this.enterModifyPhase(`Used ${this.explorationStepsWithoutWrite} exploration tools without editing files.`);
    }
  }

  private trailingNoProgressCount(predicate: (entry: ToolObservation) => boolean): number {
    let count = 0;
    for (let index = this.history.length - 1; index >= 0; index--) {
      const entry = this.history[index];
      if (!predicate(entry)) {
        break;
      }
      if (entry.progress) {
        break;
      }
      count += 1;
    }
    return count;
  }

  private freezeSearch(reason: string) {
    if (this.searchFrozen) {
      return;
    }
    this.searchFrozen = true;
    this.reminderQueue.push(buildSearchFreezeReminder(reason));
  }

  private enterModifyPhase(reason: string) {
    if (this.explorationFrozen) {
      return;
    }
    this.phase = "modify";
    this.explorationFrozen = true;
    this.searchFrozen = true;
    this.reminderQueue.push(buildExplorationFreezeReminder(reason));
  }

  private isModificationTask(): boolean {
    return this.taskType === "implementation" || this.taskType === "debugging";
  }

  private historyCount(predicate: (entry: ToolObservation) => boolean): number {
    return this.history.reduce((count, entry) => count + (predicate(entry) ? 1 : 0), 0);
  }

  private maybeWarnOnSoftBudgets(isSearchStep: boolean, isReadStep: boolean) {
    if (!this.softTotalWarned && this.totalSteps >= this.budget.softTotalSteps) {
      this.softTotalWarned = true;
      this.reminderQueue.push(buildLoopWarningReminder(
        "This task has already used many tool steps. Do not keep exploring by default; synthesize what you know unless a concrete missing gap remains.",
      ));
    }

    if (isSearchStep && !this.softSearchWarned && this.searchSteps >= this.budget.softSearchSteps) {
      this.softSearchWarned = true;
      this.reminderQueue.push(buildLoopWarningReminder(
        "This task has already used many search steps. Stop broad searching unless you can point to a specific remaining evidence gap.",
      ));
    }

    if (isReadStep && !this.softReadWarned && this.readSteps >= this.budget.softReadSteps) {
      this.softReadWarned = true;
      this.reminderQueue.push(buildLoopWarningReminder(
        "This task has already used many file reads. Stop re-reading context unless a concrete edit requires one exact missing snippet.",
      ));
    }
  }
}

function isExplorationIntent(intent: ReturnType<typeof analyzeToolIntent>): boolean {
  return intent.family === "search" || intent.family === "read" || intent.family === "web";
}

function isSuccessfulWriteIntent(intent: ReturnType<typeof analyzeToolIntent>, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "command_error") {
    return false;
  }
  return intent.family === "write" || intent.family === "edit" || result.metadata?.kind === "write" || result.metadata?.kind === "edit";
}

function metadataKindForFamily(family: ReturnType<typeof analyzeToolIntent>["family"]): ToolResultMetadata["kind"] {
  switch (family) {
    case "search":
    case "read":
    case "write":
    case "edit":
    case "shell":
    case "web":
      return family;
    default:
      return "security";
  }
}

function inferProgress(intent: ReturnType<typeof analyzeToolIntent>, result: ToolResult): boolean {
  if (result.status === "blocked" || result.status === "timeout" || result.status === "command_error") {
    return false;
  }

  if (intent.family === "search") {
    const matches = result.metadata?.matches;
    if (typeof matches === "number") {
      return matches > 0;
    }
    const normalized = result.content.toLowerCase();
    if (normalized.includes("no matches found") || normalized.includes("(no matches)")) {
      return false;
    }
    return !result.isError;
  }

  return !result.isError;
}

function blockedResult(
  content: string,
  status: ToolResult["status"],
  reason: string,
  kind: ToolResultMetadata["kind"] = "security",
): ToolResult {
  return {
    content,
    isError: true,
    status,
    metadata: {
      kind,
      reason,
    },
  };
}
