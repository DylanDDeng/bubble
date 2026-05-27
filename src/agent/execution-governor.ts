import { analyzeToolIntent } from "./tool-intent.js";
import type { ParsedToolCall, ToolRegistryEntry, ToolResult } from "../types.js";
import type { TaskType } from "./task-classifier.js";
import { buildInvestigationReminder, buildLoopWarningReminder } from "../prompt/reminders.js";

interface GovernorBudget {
  softTotalSteps: number;
  softSearchSteps: number;
  softReadSteps: number;
  warningExactRepeats: number;
  warningFamilyRepeats: number;
}

interface ToolObservation {
  family: ReturnType<typeof analyzeToolIntent>["family"];
  signature?: string;
  familyKey?: string;
  progress: boolean;
  mutationVersion: number;
}

export interface GovernorDecision {
  blockedResult?: ToolResult;
}

const BUDGETS: Record<TaskType, GovernorBudget> = {
  security_investigation: {
    softTotalSteps: 14,
    softSearchSteps: 6,
    softReadSteps: 8,
    warningExactRepeats: 2,
    warningFamilyRepeats: 2,
  },
  code_search: {
    softTotalSteps: 16,
    softSearchSteps: 8,
    softReadSteps: 10,
    warningExactRepeats: 2,
    warningFamilyRepeats: 3,
  },
  debugging: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 7,
    warningExactRepeats: 1,
    warningFamilyRepeats: 3,
  },
  implementation: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 6,
    warningExactRepeats: 1,
    warningFamilyRepeats: 3,
  },
  code_review: {
    softTotalSteps: 14,
    softSearchSteps: 6,
    softReadSteps: 8,
    warningExactRepeats: 2,
    warningFamilyRepeats: 3,
  },
  code_explanation: {
    softTotalSteps: 12,
    softSearchSteps: 6,
    softReadSteps: 8,
    warningExactRepeats: 2,
    warningFamilyRepeats: 3,
  },
  repo_orientation: {
    softTotalSteps: 12,
    softSearchSteps: 6,
    softReadSteps: 8,
    warningExactRepeats: 2,
    warningFamilyRepeats: 3,
  },
  product_discussion: {
    softTotalSteps: 10,
    softSearchSteps: 4,
    softReadSteps: 4,
    warningExactRepeats: 2,
    warningFamilyRepeats: 2,
  },
  general: {
    softTotalSteps: 18,
    softSearchSteps: 8,
    softReadSteps: 10,
    warningExactRepeats: 2,
    warningFamilyRepeats: 3,
  },
};

export class ExecutionGovernor {
  private budget: GovernorBudget;
  private history: ToolObservation[] = [];
  private totalSteps = 0;
  private searchSteps = 0;
  private readSteps = 0;
  private mutationVersion = 0;
  private reminderQueue: string[] = [];
  private warnedFamilies = new Set<string>();
  private warnedSignatures = new Set<string>();
  private softTotalWarned = false;
  private softSearchWarned = false;
  private softReadWarned = false;

  constructor(taskType: TaskType) {
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
      searchFrozen: false,
      explorationFrozen: false,
      phase: "observe" as const,
    };
  }

  filterToolDefinitions(toolDefinitions: ToolRegistryEntry[]): ToolRegistryEntry[] {
    return toolDefinitions;
  }

  beforeToolCall(toolCall: ParsedToolCall): GovernorDecision {
    const intent = analyzeToolIntent(toolCall);

    if (intent.family === "read") {
      const signature = intent.read?.signature;
      if (signature && this.hasCurrentMutationObservation((entry) => entry.signature === signature)) {
        this.warnOnce(`read:${signature}`, "This exact file range was already read since the last successful edit/write. If the content is still available and nothing changed, use the prior result; otherwise it is okay to re-read to recover context or verify a change.");
      }
    }

    if (intent.family === "search") {
      const signature = intent.search?.signature;
      const familyKey = intent.search?.familyKey;
      if (signature && this.trailingNoProgressCount((entry) => entry.signature === signature) >= this.budget.warningExactRepeats) {
        this.warnOnce(`search:${signature}`, "This search is very similar to one you already ran and it did not produce new evidence. Change the query/path, follow a concrete lead, or summarize the strongest findings.");
      }

      if (familyKey) {
        const familyNoProgress = this.trailingNoProgressCount((entry) => entry.familyKey === familyKey);
        if (familyNoProgress >= this.budget.warningFamilyRepeats && !this.warnedFamilies.has(familyKey)) {
          this.warnedFamilies.add(familyKey);
          this.reminderQueue.push(buildLoopWarningReminder(
            "Repeated searches in the same family are yielding little new evidence. Change your hypothesis, narrow the path, follow a specific file lead, or summarize current findings instead of repeating variants.",
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
      mutationVersion: this.mutationVersion,
    });

    if (isSuccessfulWriteIntent(intent, result)) {
      this.mutationVersion += 1;
    }
  }

  private trailingNoProgressCount(predicate: (entry: ToolObservation) => boolean): number {
    let count = 0;
    for (let index = this.history.length - 1; index >= 0; index--) {
      const entry = this.history[index];
      if (entry.mutationVersion !== this.mutationVersion) {
        break;
      }
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

  private hasCurrentMutationObservation(predicate: (entry: ToolObservation) => boolean): boolean {
    return this.history.some((entry) => entry.mutationVersion === this.mutationVersion && predicate(entry));
  }

  private warnOnce(key: string, reason: string): void {
    if (this.warnedSignatures.has(key)) {
      return;
    }
    this.warnedSignatures.add(key);
    this.reminderQueue.push(buildLoopWarningReminder(reason));
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

function isSuccessfulWriteIntent(intent: ReturnType<typeof analyzeToolIntent>, result: ToolResult): boolean {
  if (result.isError || result.status === "blocked" || result.status === "command_error") {
    return false;
  }
  return intent.family === "write" || intent.family === "edit" || result.metadata?.kind === "write" || result.metadata?.kind === "edit" || result.metadata?.kind === "patch";
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
