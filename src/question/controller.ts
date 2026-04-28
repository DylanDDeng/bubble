import type { QuestionAnswer, QuestionEvent, QuestionPrompt, QuestionRequest, QuestionToolRef } from "./types.js";
import { QuestionRejectedError } from "./types.js";

interface PendingQuestion {
  request: QuestionRequest;
  resolve: (answers: QuestionAnswer[]) => void;
  reject: (error: QuestionRejectedError) => void;
}

export interface QuestionAskInput {
  sessionID?: string;
  questions: QuestionPrompt[];
  tool?: QuestionToolRef;
}

export class QuestionController {
  private pending = new Map<string, PendingQuestion>();
  private listeners = new Set<(event: QuestionEvent) => void>();
  private counter = 0;

  ask(input: QuestionAskInput): Promise<QuestionAnswer[]> {
    const request: QuestionRequest = {
      id: this.nextID(),
      sessionID: input.sessionID,
      questions: input.questions.map(normalizePrompt),
      tool: input.tool,
      createdAt: Date.now(),
    };

    const promise = new Promise<QuestionAnswer[]>((resolve, reject) => {
      this.pending.set(request.id, {
        request,
        resolve,
        reject,
      });
    });

    this.emit({ type: "asked", request });
    return promise.finally(() => {
      this.pending.delete(request.id);
    });
  }

  reply(requestID: string, answers: QuestionAnswer[]): boolean {
    const pending = this.pending.get(requestID);
    if (!pending) return false;
    const normalized = normalizeAnswers(pending.request.questions.length, answers);
    this.pending.delete(requestID);
    this.emit({ type: "replied", request: pending.request, answers: normalized });
    pending.resolve(normalized);
    return true;
  }

  reject(requestID: string): boolean {
    const pending = this.pending.get(requestID);
    if (!pending) return false;
    this.pending.delete(requestID);
    this.emit({ type: "rejected", request: pending.request });
    pending.reject(new QuestionRejectedError());
    return true;
  }

  list(sessionID?: string): QuestionRequest[] {
    const items = Array.from(this.pending.values(), (entry) => entry.request);
    return sessionID === undefined ? items : items.filter((request) => request.sessionID === sessionID);
  }

  subscribe(listener: (event: QuestionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  rejectAll() {
    for (const id of [...this.pending.keys()]) {
      this.reject(id);
    }
  }

  private emit(event: QuestionEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("[question] listener failed", err);
      }
    }
  }

  private nextID(): string {
    this.counter += 1;
    return `question_${Date.now().toString(36)}_${this.counter.toString(36)}`;
  }
}

function normalizePrompt(input: QuestionPrompt): QuestionPrompt {
  return {
    header: String(input.header ?? "").trim(),
    question: String(input.question ?? "").trim(),
    options: Array.isArray(input.options)
      ? input.options.map((option) => ({
          label: String(option?.label ?? "").trim(),
          description: String(option?.description ?? "").trim(),
        }))
      : [],
    multiple: input.multiple === true,
    custom: input.custom === false ? false : undefined,
  };
}

function normalizeAnswers(count: number, answers: QuestionAnswer[]): QuestionAnswer[] {
  return Array.from({ length: count }, (_, index) => {
    const answer = answers[index];
    if (!Array.isArray(answer)) return [];
    return answer.map((item) => String(item).trim()).filter(Boolean);
  });
}

export type { QuestionAnswer, QuestionEvent, QuestionPrompt, QuestionRequest };
export { QuestionRejectedError };
