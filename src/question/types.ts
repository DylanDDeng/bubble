export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  /** Very short label used in tabs for multi-question prompts. */
  header: string;
  /** Complete user-facing question text. */
  question: string;
  /** Fixed choices shown to the user. */
  options: QuestionOption[];
  /** Allow selecting more than one option. Defaults to false. */
  multiple?: boolean;
  /** Allow a custom free-form answer. Defaults to true. */
  custom?: boolean;
}

export type QuestionAnswer = string[];

export interface QuestionToolRef {
  messageID?: string;
  callID: string;
}

export interface QuestionRequest {
  id: string;
  sessionID?: string;
  questions: QuestionPrompt[];
  tool?: QuestionToolRef;
  createdAt: number;
}

export type QuestionEvent =
  | { type: "asked"; request: QuestionRequest }
  | { type: "replied"; request: QuestionRequest; answers: QuestionAnswer[] }
  | { type: "rejected"; request: QuestionRequest };

export class QuestionRejectedError extends Error {
  constructor(message = "The user dismissed this question") {
    super(message);
    this.name = "QuestionRejectedError";
  }
}

