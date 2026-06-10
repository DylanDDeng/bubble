import { randomUUID } from "node:crypto";
import {
  explainHookEvent,
  formatHooksStatus,
  getProjectHookFingerprint,
  loadHookConfig,
  type LoadHookConfigOptions,
} from "./config.js";
import { appendHookLog, readRecentHookLogs } from "./log.js";
import { runHookCommand } from "./runner.js";
import { trustProjectHooks, untrustProjectHooks } from "./trust.js";
import {
  BLOCKABLE_HOOK_EVENTS,
  type HookCombinedResult,
  type HookEventEnvelope,
  type HookEventName,
  type HookProgressEvent,
  type HookRunRequest,
  type HookRunSingleResult,
  type LoadedHookConfig,
  type LoadedHookRule,
} from "./types.js";

export interface ExternalHookControllerOptions extends LoadHookConfigOptions {
  sessionId?: string;
}

export interface HookRunOptions {
  abortSignal?: AbortSignal;
  onProgress?: (event: HookProgressEvent) => void;
}

export class ExternalHookController {
  private config: LoadedHookConfig;
  private readonly disabledByDepth: boolean;

  constructor(private readonly options: ExternalHookControllerOptions) {
    this.config = loadHookConfig(options);
    this.disabledByDepth = process.env.BUBBLE_HOOK_DEPTH === "1";
  }

  reload(): LoadedHookConfig {
    this.config = loadHookConfig(this.options);
    return this.config;
  }

  getConfig(): LoadedHookConfig {
    return this.config;
  }

  status(): string {
    return formatHooksStatus(this.config);
  }

  explain(eventName: HookEventName): string {
    return explainHookEvent(eventName, this.config);
  }

  logs(limit = 20): string {
    const entries = readRecentHookLogs(limit, this.options);
    if (entries.length === 0) return "No hook logs yet.";
    return entries.map((entry) => {
      const hook = entry.hookId ? ` ${entry.hookId}` : "";
      const event = entry.eventName ? ` ${entry.eventName}` : "";
      const decision = entry.decision ? ` ${entry.decision}` : "";
      return `${entry.ts} [${entry.level}]${event}${hook}${decision} - ${entry.message}`;
    }).join("\n");
  }

  trustProject(): string {
    const fingerprint = getProjectHookFingerprint(this.options);
    if (!fingerprint) return "No project hooks are configured.";
    trustProjectHooks(fingerprint, this.options);
    this.reload();
    return `Trusted project hooks for fingerprint ${fingerprint.fingerprint.slice(0, 12)}.`;
  }

  untrustProject(): string {
    const key = this.config.projectTrust.projectKey;
    if (!key) return "No project hooks are configured.";
    const changed = untrustProjectHooks(key, this.options);
    this.reload();
    return changed ? "Untrusted project hooks for this project." : "Project hooks were not trusted.";
  }

  async test(eventName: HookEventName, target?: string): Promise<string> {
    const result = await this.runEvent({
      eventName,
      cwd: this.options.cwd,
      sessionId: this.options.sessionId,
      agentRole: "driver",
      target,
      payload: {
        test: true,
        target,
      },
    });
    return formatCombinedResult(result);
  }

  async runEvent(request: HookRunRequest, runOptions: HookRunOptions = {}): Promise<HookCombinedResult> {
    if (this.disabledByDepth) {
      return emptyResult(request.eventName, ["Hooks disabled because BUBBLE_HOOK_DEPTH=1."]);
    }

    const agentRole = request.agentRole ?? "parent";
    const candidates = this.config.rules.filter((rule) => {
      if (!rule.enabled || !rule.trusted) return false;
      if (!rule.events.includes(request.eventName)) return false;
      if (agentRole === "subagent" && !rule.inheritToSubagents) return false;
      return matchesRule(rule, request);
    });
    const diagnostics: string[] = [];
    const results: HookRunSingleResult[] = [];
    const modelContext: string[] = [];
    const blockable = BLOCKABLE_HOOK_EVENTS.has(request.eventName);
    let decision: HookCombinedResult["decision"] = "allow";
    let reason: string | undefined;
    let sourceHookId: string | undefined;
    let source: HookCombinedResult["source"] | undefined;

    for (const rule of candidates) {
      const start: HookProgressEvent = {
        type: "hook_start",
        eventName: request.eventName,
        hookId: rule.id,
        source: rule.source,
      };
      runOptions.onProgress?.(start);
      appendHookLog({
        ts: new Date().toISOString(),
        level: "info",
        eventName: request.eventName,
        hookId: rule.id,
        message: "Hook started.",
      }, this.options);

      const envelope = buildEnvelope(rule, {
        ...request,
        sessionId: request.sessionId ?? this.options.sessionId,
        agentRole,
      });
      const runnerResult = await runHookCommand(rule, envelope, { abortSignal: runOptions.abortSignal });
      const single: HookRunSingleResult = {
        hookId: rule.id,
        eventName: request.eventName,
        source: rule.source,
        decision: runnerResult.decision,
        reason: runnerResult.reason,
        modelContext: runnerResult.modelContext,
        exitCode: runnerResult.exitCode,
        signal: runnerResult.signal,
        elapsedMs: runnerResult.elapsedMs,
        stdout: runnerResult.stdout,
        stderr: runnerResult.stderr,
        truncated: runnerResult.truncated,
        error: runnerResult.error,
      };
      results.push(single);
      modelContext.push(...runnerResult.modelContext);

      if (runnerResult.error) {
        const event: HookProgressEvent = {
          type: "hook_error",
          eventName: request.eventName,
          hookId: rule.id,
          source: rule.source,
          elapsedMs: runnerResult.elapsedMs,
          decision: runnerResult.decision,
          reason: runnerResult.reason,
          error: runnerResult.error,
        };
        runOptions.onProgress?.(event);
        appendHookLog({
          ts: new Date().toISOString(),
          level: runnerResult.decision === "deny" ? "error" : "warn",
          eventName: request.eventName,
          hookId: rule.id,
          decision: runnerResult.decision,
          message: runnerResult.error,
        }, this.options);
      } else {
        const event: HookProgressEvent = {
          type: "hook_end",
          eventName: request.eventName,
          hookId: rule.id,
          source: rule.source,
          elapsedMs: runnerResult.elapsedMs,
          decision: runnerResult.decision,
          reason: runnerResult.reason,
        };
        runOptions.onProgress?.(event);
        appendHookLog({
          ts: new Date().toISOString(),
          level: "info",
          eventName: request.eventName,
          hookId: rule.id,
          decision: runnerResult.decision,
          message: runnerResult.reason ?? "Hook completed.",
        }, this.options);
      }

      if (runnerResult.decision === "deny" && !blockable) {
        diagnostics.push(`${rule.id} returned deny for observe-only event ${request.eventName}; denial ignored.`);
        continue;
      }
      if (runnerResult.decision === "deny") {
        decision = "deny";
        reason = runnerResult.reason ?? `Denied by hook ${rule.id}.`;
        sourceHookId = rule.id;
        source = rule.source;
        break;
      }
    }

    return {
      eventName: request.eventName,
      decision,
      reason,
      sourceHookId,
      source,
      modelContext,
      results,
      diagnostics,
      matched: candidates.length,
    };
  }
}

function matchesRule(rule: LoadedHookRule, request: HookRunRequest): boolean {
  if (!rule.matcher) return true;
  const target = request.target ?? JSON.stringify(request.payload ?? {});
  return new RegExp(rule.matcher).test(target);
}

function buildEnvelope(
  rule: LoadedHookRule,
  request: HookRunRequest & { agentRole: NonNullable<HookRunRequest["agentRole"]> },
): HookEventEnvelope {
  const payload = { ...(request.payload ?? {}) };
  const redacted: string[] = [];
  const full = request.fullPayload ?? {};
  for (const [key, value] of Object.entries(full)) {
    if (rule.include.includes("all") || rule.include.includes(key)) {
      payload[key] = value;
    } else {
      redacted.push(key);
    }
  }
  return {
    schemaVersion: 1,
    eventName: request.eventName,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: request.cwd,
    sessionId: request.sessionId,
    runId: request.runId,
    agentRole: request.agentRole,
    subAgentId: request.subAgentId,
    target: request.target,
    payload,
    redacted,
  };
}

function emptyResult(eventName: HookEventName, diagnostics: string[] = []): HookCombinedResult {
  return {
    eventName,
    decision: "allow",
    modelContext: [],
    results: [],
    diagnostics,
    matched: 0,
  };
}

function formatCombinedResult(result: HookCombinedResult): string {
  const lines = [
    `Hook test ${result.eventName}: ${result.decision}${result.reason ? ` - ${result.reason}` : ""}`,
    `Matched: ${result.matched}`,
  ];
  for (const item of result.results) {
    const suffix = item.reason ? ` - ${item.reason}` : item.error ? ` - ${item.error}` : "";
    lines.push(`  ${item.decision} ${item.hookId} (${item.elapsedMs}ms)${suffix}`);
  }
  if (result.diagnostics.length) {
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`  ${diagnostic}`);
  }
  return lines.join("\n");
}
