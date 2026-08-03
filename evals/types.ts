export interface TaskScore {
  pass: boolean;
  notes?: string;
}

export interface EvalTask {
  id: string;
  /** The user prompt handed to the agent. */
  prompt: string;
  /** Seed the temp workspace with starting files. */
  setup(dir: string): void | Promise<void>;
  /** Objective, programmatic check after the turn completes. */
  score(dir: string): TaskScore | Promise<TaskScore>;
}

/** One agent configuration under test. */
export interface EvalConfig {
  name: string;
  /** "provider:model"; defaults to the user's configured default model. */
  model?: string;
  thinkingLevel?: string;
  /** Appended to the system prompt — the knob for prompt-variant A/B runs. */
  appendSystemPrompt?: string;
}

/** Outcome of one task run under one config. */
export interface RunRecord {
  taskId: string;
  configName: string;
  repetition: number;
  pass: boolean;
  notes?: string;
  error?: string;
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  turns: number;
  /** As resolved by the SDK (explicit config > user default > model default). */
  resolvedModel?: string;
  resolvedThinkingLevel?: string;
  sessionArtifact?: string;
}
