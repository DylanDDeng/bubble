import { describe, expect, it } from "vitest";
import {
  isQueuedInputForCurrentSession,
  queuedAndPendingDisplayKeys,
  type QueuedInput,
} from "../tui/model/input-queue.js";

const queued = (sessionFile?: string): QueuedInput => ({
  payload: { text: "hello", images: [] },
  sessionFile,
});

describe("Ink queued input session ownership", () => {
  it("allows queued input from the active session", () => {
    expect(isQueuedInputForCurrentSession(queued("/tmp/a.jsonl"), "/tmp/a.jsonl")).toBe(true);
  });

  it("drops queued input from another session", () => {
    expect(isQueuedInputForCurrentSession(queued("/tmp/a.jsonl"), "/tmp/b.jsonl")).toBe(false);
  });

  it("keeps legacy or sessionless queued input when either side has no session file", () => {
    expect(isQueuedInputForCurrentSession(queued(), "/tmp/a.jsonl")).toBe(true);
    expect(isQueuedInputForCurrentSession(queued("/tmp/a.jsonl"), undefined)).toBe(true);
  });

  it("collects display keys from queued inputs and pending steers", () => {
    expect([...queuedAndPendingDisplayKeys(
      [
        { payload: { text: "a", images: [] }, displayKey: "queued-a" },
        { payload: { text: "b", images: [] } },
      ],
      [
        { displayKey: "steer-a" },
        { displayKey: "queued-a" },
      ],
    )]).toEqual(["queued-a", "steer-a"]);
  });
});
