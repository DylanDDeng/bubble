import type { SubmitPayload } from "./input-box.js";

export interface QueuedInput {
  payload: SubmitPayload;
  displayKey?: string;
  sessionFile?: string;
}

export interface PendingSteerMeta {
  displayKey: string;
  sessionFile?: string;
}

export function isQueuedInputForCurrentSession(
  input: QueuedInput,
  currentSessionFile?: string,
): boolean {
  if (!input.sessionFile || !currentSessionFile) return true;
  return input.sessionFile === currentSessionFile;
}

export function queuedAndPendingDisplayKeys(
  queuedInputs: QueuedInput[],
  pendingSteers: Iterable<PendingSteerMeta>,
): Set<string> {
  const keys = new Set<string>();
  for (const input of queuedInputs) {
    if (input.displayKey) keys.add(input.displayKey);
  }
  for (const steer of pendingSteers) {
    if (steer.displayKey) keys.add(steer.displayKey);
  }
  return keys;
}
