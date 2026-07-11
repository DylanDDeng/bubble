import type { AgentEvent } from "../types.js";
import type { ThinkingLevel } from "../types.js";

export type ExternalRuntimeState =
  | "unavailable"
  | "signed_out"
  | "ready"
  | "running"
  | "failed"
  | "disposed";

export interface ExternalRuntimeCapabilities {
  chat: boolean;
  tools: boolean;
  memory: boolean;
  subagents: boolean;
  plan: boolean;
  web: boolean;
  sessionLoad: boolean;
  workspace: boolean;
  modelControl: boolean;
  reasoningControl: boolean;
}

export interface ExternalRuntimeBinaryInfo {
  path: string;
  version: string;
  sha256: string;
}

export interface ExternalRuntimeStatus {
  provider: "grok";
  state: ExternalRuntimeState;
  capabilities: ExternalRuntimeCapabilities;
  binary?: ExternalRuntimeBinaryInfo;
  sessionId?: string;
  /** A deliberately terse, credential-free diagnostic suitable for the TUI. */
  message?: string;
}

export interface ExternalRuntimeSession {
  id: string;
  provider: "grok";
  modelId?: string;
  reasoningEffort?: ThinkingLevel;
}

export interface ExternalRuntimeModel {
  id: string;
  name: string;
  reasoningLevels: ThinkingLevel[];
  defaultReasoningLevel: ThinkingLevel;
}

export interface ExternalRuntimeModelSelection {
  modelId?: string;
  reasoningEffort: ThinkingLevel;
}

export interface ExternalRuntimeRunOptions {
  sessionId?: string;
  signal?: AbortSignal;
  /** Lets callers invalidate late ACP notifications after a UI generation swap. */
  generation?: number;
}

export interface ExternalRuntimeManager {
  inspect(): Promise<ExternalRuntimeStatus>;
  login(signal?: AbortSignal, onBrowserOpened?: () => void): Promise<void>;
  logout(): Promise<void>;
  newSession(): Promise<ExternalRuntimeSession>;
  loadSession(id: string): Promise<ExternalRuntimeSession>;
  hydrateSession(id: string, modelId?: string, reasoningEffort?: ThinkingLevel): Promise<ExternalRuntimeSession>;
  listModels(): Promise<ExternalRuntimeModel[]>;
  getModelSelection(): ExternalRuntimeModelSelection;
  setModel(modelId: string, reasoningEffort?: ThinkingLevel): Promise<ExternalRuntimeModelSelection>;
  run(prompt: string, options?: ExternalRuntimeRunOptions): AsyncIterable<AgentEvent>;
  cancel(sessionId?: string): Promise<void>;
  dispose(): Promise<void>;
}
