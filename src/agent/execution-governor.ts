import { analyzeToolIntent } from "./tool-intent.js";
import type { ParsedToolCall, ToolRegistryEntry, ToolResult } from "../types.js";
import type { TaskType } from "./task-classifier.js";
import { buildInvestigationReminder, buildLoopWarningReminder, buildSearchFreezeReminder } from "../prompt/reminders.js";

interface GovernorBudget {
  softTotalSteps: number;
  softSearchSteps: number;
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
    maxNoProgressExactRepeats: 2,
    maxNoProgressFamilyRepeats: 3,
    warningFamilyRepeats: 2,
  },
  code_search: {
    softTotalSteps: 16,
    softSearchSteps: 8,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
  general: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    maxNoProgressExactRepeats: 3,
    maxNoProgressFamilyRepeats: 4,
    warningFamilyRepeats: 3,
  },
};

const SEARCH_TOOLS_DISABLED = new Set(["grep", "web_search", "web_fetch"]);

export class ExecutionGovernor {
  private budget: GovernorBudget;
  private history: ToolObservation[] = [];
  private totalSteps = 0;
  private searchSteps = 0;
  private searchFrozen = false;
  private reminderQueue: string[] = [];
  private warnedFamilies = new Set<string>();
  private softTotalWarned = false;
  private softSearchWarned = false;

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
      searchFrozen: this.searchFrozen,
    };
  }

  filterToolDefinitions(toolDefinitions: ToolRegistryEntry[]): ToolRegistryEntry[] {
    if (!this.searchFrozen) {
      return toolDefinitions;
    }

    return toolDefinitions.filter((tool) => !SEARCH_TOOLS_DISABLED.has(tool.name));
  }

  beforeToolCall(toolCall: ParsedToolCall): GovernorDecision {
    const intent = analyzeToolIntent(toolCall);

    if (intent.family === "search") {
      if (this.searchFrozen) {
        return {
          blockedResult: blockedResult(
            "Search blocked: repeated low-yield searching is now frozen for this task.",
            "blocked",
            "Search frozen due to repeated low-yield searching.",
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
    this.maybeWarnOnSoftBudgets(intent.family === "search");

    return {};
  }

  afterToolResult(toolCall: ParsedToolCall, result: ToolResult): void {
    const intent = analyzeToolIntent(toolCall);
    const progress = inferProgress(intent, result);
    this.history.push({
      family: intent.family,
      signature: intent.search?.signature,
      familyKey: intent.search?.familyKey,
      progress,
    });
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

  private maybeWarnOnSoftBudgets(isSearchStep: boolean) {
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

function blockedResult(content: string, status: ToolResult["status"], reason: string): ToolResult {
  return {
    content,
    isError: true,
    status,
    metadata: {
      kind: "security",
      reason,
    },
  };
}
