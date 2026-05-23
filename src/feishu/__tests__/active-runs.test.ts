import { describe, expect, it } from "vitest";
import { ActiveRuns } from "../runtime/active-runs.js";

describe("ActiveRuns", () => {
  it("tracks isActive correctly", async () => {
    const ar = new ActiveRuns();
    expect(ar.isActive("s1")).toBe(false);
    const { complete } = await ar.startOrReplace("s1");
    expect(ar.isActive("s1")).toBe(true);
    complete();
    expect(ar.isActive("s1")).toBe(false);
  });

  it("aborts the previous run on startOrReplace", async () => {
    const ar = new ActiveRuns();
    const first = await ar.startOrReplace("s1");
    let aborted = false;
    first.signal.addEventListener("abort", () => {
      aborted = true;
      // Simulate the run honoring the abort and completing.
      first.complete();
    });
    const second = await ar.startOrReplace("s1");
    expect(aborted).toBe(true);
    second.complete();
  });

  it("abort signals trigger correctly", async () => {
    const ar = new ActiveRuns();
    const { signal, complete } = await ar.startOrReplace("s1");
    let fired = false;
    signal.addEventListener("abort", () => { fired = true; });
    ar.abort("s1");
    expect(fired).toBe(true);
    complete();
  });

  it("abortAll returns count of aborted runs", async () => {
    const ar = new ActiveRuns();
    await ar.startOrReplace("s1");
    await ar.startOrReplace("s2");
    expect(ar.abortAll()).toBe(2);
  });
});
