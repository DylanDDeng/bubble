import { createHmac } from "node:crypto";
import { FEEDBACK_CLIENT_SECRET, FEEDBACK_WORKER_URL, isFeedbackConfigured } from "./config.js";
import type { FeedbackPayload, SubmitResult } from "./types.js";

export class FeedbackSubmitError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FeedbackSubmitError";
  }
}

export async function submitFeedback(payload: FeedbackPayload): Promise<SubmitResult> {
  if (!isFeedbackConfigured()) {
    throw new FeedbackSubmitError(
      "Feedback service is not configured (worker URL placeholder). See services/feedback-worker/README.",
    );
  }

  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", FEEDBACK_CLIENT_SECRET).update(body).digest("hex");

  let resp: Response;
  try {
    resp = await fetch(FEEDBACK_WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bubble-Auth": signature,
      },
      body,
    });
  } catch (err: any) {
    throw new FeedbackSubmitError(`Network error: ${err?.message ?? String(err)}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 429) {
      throw new FeedbackSubmitError(text || "Rate limited — please try again later.", 429);
    }
    throw new FeedbackSubmitError(
      `Server returned ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      resp.status,
    );
  }

  const json = (await resp.json()) as Partial<SubmitResult>;
  if (!json.url || typeof json.number !== "number") {
    throw new FeedbackSubmitError("Server returned malformed response");
  }
  return { url: json.url, number: json.number };
}
