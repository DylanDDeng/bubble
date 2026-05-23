/**
 * RunState — a pure, JSON-serializable view of an in-flight agent run.
 * Fed by the reducer over AgentEvent, consumed by the card renderer.
 */

import type { PermissionMode, TokenUsage } from "../../types.js";

export type RunStatus = "running" | "completed" | "interrupted" | "error" | "idle_timeout";

export interface RunStateScope {
  chatId: string;
  userId: string;
  displayName: string;
  cwd: string;
}

export type RunStateBlock = TextBlock | ThinkingBlock | ToolBlock;

export interface TextBlock {
  kind: "text";
  text: string;
  streaming: boolean;
}

export interface ThinkingBlock {
  kind: "thinking";
  text: string;
  streaming: boolean;
}

export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  argsPreview: string;
  status: "running" | "ok" | "err";
  resultPreview?: string;
  startedAt: number;
  endedAt?: number;
}

export interface RunState {
  scope: RunStateScope;
  mode: PermissionMode;
  status: RunStatus;
  blocks: RunStateBlock[];
  usage?: TokenUsage;
  startedAt: number;
  updatedAt: number;
  error?: { message: string };
}

export function createInitialRunState(input: {
  scope: RunStateScope;
  mode: PermissionMode;
}): RunState {
  const now = Date.now();
  return {
    scope: input.scope,
    mode: input.mode,
    status: "running",
    blocks: [],
    startedAt: now,
    updatedAt: now,
  };
}
