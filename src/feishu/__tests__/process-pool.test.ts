import { describe, expect, it } from "vitest";
import { ProcessPool } from "../runtime/process-pool.js";

describe("ProcessPool", () => {
  it("rejects bad concurrency at construction", () => {
    expect(() => new ProcessPool({ concurrency: 0 })).toThrow();
  });

  it("caps concurrent work", async () => {
    const pool = new ProcessPool({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;
    const work = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    await Promise.all([
      pool.run(work),
      pool.run(work),
      pool.run(work),
      pool.run(work),
      pool.run(work),
    ]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("releases on error", async () => {
    const pool = new ProcessPool({ concurrency: 1 });
    await expect(pool.run(async () => { throw new Error("boom"); })).rejects.toThrow();
    // If release didn't fire, this second run would deadlock.
    await expect(pool.run(async () => 42)).resolves.toBe(42);
  });
});
