import { createHash } from "node:crypto";
import type { SubmitPayload } from "./composer-types.js";

export type StartingSubmitDecision = "accept" | "ignore" | "queue";

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function submitPayloadFingerprint(payload: SubmitPayload): string {
  return JSON.stringify({
    text: payload.text,
    displayText: payload.displayText ?? "",
    images: payload.images.map((image) => ({
      mediaType: image.mediaType,
      bytes: image.bytes,
      filename: image.filename ?? "",
      sourcePath: image.sourcePath ?? "",
      dataUrlHash: hashValue(image.dataUrl),
    })),
  });
}

export function decideStartingSubmit(
  activeFingerprint: string | null,
  payload: SubmitPayload,
): StartingSubmitDecision {
  return decideStartingSubmitFingerprint(activeFingerprint, submitPayloadFingerprint(payload));
}

export function decideStartingSubmitFingerprint(
  activeFingerprint: string | null,
  submitFingerprint: string,
): StartingSubmitDecision {
  if (!activeFingerprint) return "accept";
  return activeFingerprint === submitFingerprint ? "ignore" : "queue";
}
