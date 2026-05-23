export interface Env {
  GITHUB_TOKEN: string;
  CLIENT_SECRET: string;
  FEEDBACK_REPO: string;
  RATE_KV: KVNamespace;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "error";
  content: string;
  timestamp?: number;
}

export interface FeedbackPayload {
  description: string;
  version: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  provider: string;
  model: string;
  transcript: TranscriptMessage[];
  recentError?: string;
  submittedAt: number;
  clientId: string;
}
