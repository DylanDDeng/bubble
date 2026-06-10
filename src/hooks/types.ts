import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import type { ContentPart, PermissionMode, ToolResult } from "../types.js";

export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreModelCall"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "PermissionResult"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "SteerInputApplied"
  | "QueuedInputRejected";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreModelCall",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionResult",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "SteerInputApplied",
  "QueuedInputRejected",
];

export const BLOCKABLE_HOOK_EVENTS = new Set<HookEventName>([
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PreCompact",
]);

export type HookSourceScope = "user" | "project" | "local";
export type HookAgentRole = "parent" | "subagent" | "driver";
export type HookFailurePolicy = "allow" | "block";
export type HookDecision = "allow" | "deny";

export interface HookCommandConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface RawHookRule {
  id?: unknown;
  name?: unknown;
  event?: unknown;
  events?: unknown;
  matcher?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: unknown;
  maxOutputBytes?: unknown;
  enabled?: unknown;
  onError?: unknown;
  failurePolicy?: unknown;
  include?: unknown;
  exposeToModel?: unknown;
  inheritToSubagents?: unknown;
  priority?: unknown;
}

export interface HookRule {
  id: string;
  events: HookEventName[];
  matcher?: string;
  command: HookCommandConfig;
  timeoutMs: number;
  maxOutputBytes: number;
  enabled: boolean;
  onError: HookFailurePolicy;
  include: string[];
  exposeToModel: boolean;
  inheritToSubagents: boolean;
  priority: number;
}

export interface HookRuleSource {
  scope: HookSourceScope;
  path: string;
  index: number;
}

export interface LoadedHookRule extends HookRule {
  source: HookRuleSource;
  trusted: boolean;
  trustRequired: boolean;
}

export interface HookDiagnostic {
  scope: HookSourceScope;
  path: string;
  message: string;
}

export interface ProjectHookTrustStatus {
  required: boolean;
  trusted: boolean;
  projectKey?: string;
  fingerprint?: string;
  trustedFingerprint?: string;
  reason?: string;
}

export interface LoadedHookConfig {
  rules: LoadedHookRule[];
  diagnostics: HookDiagnostic[];
  paths: Record<HookSourceScope, string>;
  projectTrust: ProjectHookTrustStatus;
}

export interface HookEventEnvelope {
  schemaVersion: 1;
  eventName: HookEventName;
  eventId: string;
  timestamp: string;
  cwd: string;
  sessionId?: string;
  runId?: string;
  agentRole: HookAgentRole;
  subAgentId?: string;
  target?: string;
  payload: Record<string, unknown>;
  redacted: string[];
}

export interface HookRunRequest {
  eventName: HookEventName;
  cwd: string;
  sessionId?: string;
  runId?: string;
  agentRole?: HookAgentRole;
  subAgentId?: string;
  target?: string;
  payload?: Record<string, unknown>;
  fullPayload?: Record<string, unknown>;
}

export interface HookRunSingleResult {
  hookId: string;
  eventName: HookEventName;
  source: HookRuleSource;
  decision: HookDecision;
  reason?: string;
  modelContext: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  elapsedMs: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  error?: string;
}

export interface HookCombinedResult {
  eventName: HookEventName;
  decision: HookDecision;
  reason?: string;
  sourceHookId?: string;
  source?: HookRuleSource;
  modelContext: string[];
  results: HookRunSingleResult[];
  diagnostics: string[];
  matched: number;
}

export interface HookProgressEvent {
  type: "hook_start" | "hook_end" | "hook_error";
  eventName: HookEventName;
  hookId: string;
  source: HookRuleSource;
  elapsedMs?: number;
  decision?: HookDecision;
  reason?: string;
  error?: string;
}

export interface HookRunnerResult {
  decision: HookDecision;
  reason?: string;
  modelContext: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  elapsedMs: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  error?: string;
}

export interface HookApprovalPayload {
  request: Pick<ApprovalRequest, "type"> & Record<string, unknown>;
  mode?: PermissionMode;
}

export interface HookApprovalResultPayload extends HookApprovalPayload {
  decision: ApprovalDecision["action"];
  feedback?: string;
}

export interface HookToolPayload {
  id: string;
  name: string;
  argsPreview?: string;
  args?: unknown;
}

export interface HookToolResultPayload extends HookToolPayload {
  resultPreview?: string;
  result?: ToolResult;
  isError?: boolean;
}

export function isHookEventName(value: unknown): value is HookEventName {
  return typeof value === "string" && (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

export function normalizeHookInput(input: string | ContentPart[]): Record<string, unknown> {
  if (typeof input === "string") {
    return {
      promptPreview: truncateHookText(input, 240),
      promptLength: input.length,
    };
  }
  return {
    promptPreview: truncateHookText(JSON.stringify(input), 240),
    contentParts: input.length,
  };
}

export function truncateHookText(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}
