/**
 * Endpoint and shared identifier for the feedback submission service.
 *
 * WORKER_URL is updated after the first `wrangler deploy` — until then the
 * /feedback command will fail with a helpful error.
 *
 * CLIENT_SECRET is intentionally embedded in the published package. It is NOT
 * a secret in the cryptographic sense — it exists only to make it slightly
 * harder for casual scripts to spam the endpoint. The real abuse defence is
 * per-IP rate limiting in the Worker plus the minimum-scope GitHub token.
 */
export const FEEDBACK_WORKER_URL = "https://bubble-feedback.chengshengdeng97.workers.dev/submit";

export const FEEDBACK_CLIENT_SECRET = "a4826c3bde789f6e0b06ffbc39e64c029bf0b5d79f10dba0f2ad09362118dd2e";

export function isFeedbackConfigured(): boolean {
  return !FEEDBACK_WORKER_URL.includes("REPLACE_AFTER_DEPLOY");
}
