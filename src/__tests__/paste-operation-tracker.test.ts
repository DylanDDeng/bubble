import { describe, expect, it } from "vitest";
import { PasteOperationTracker } from "../tui-ink/paste-operation-tracker.js";

describe("paste operation tracker", () => {
  it("keeps a newer paste pending when an older paste finishes", () => {
    const tracker = new PasteOperationTracker();
    const first = tracker.begin();
    const second = tracker.begin();

    tracker.finish(first);
    expect(tracker.hasPending).toBe(true);
    expect(tracker.pendingCount).toBe(1);

    tracker.finish(second);
    expect(tracker.hasPending).toBe(false);
  });

  it("does not let a stale completion clear a paste started after invalidation", () => {
    const tracker = new PasteOperationTracker();
    const stale = tracker.begin();
    tracker.invalidateAll();
    const current = tracker.begin();

    tracker.finish(stale);
    expect(tracker.hasPending).toBe(true);

    tracker.finish(current);
    expect(tracker.hasPending).toBe(false);
  });
});
