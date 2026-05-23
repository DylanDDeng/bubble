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

export interface SubmitResult {
  url: string;
  number: number;
}
