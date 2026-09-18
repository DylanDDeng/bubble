import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: FakeChild[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = undefined;
  unref() {}
}

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: () => {
    const child = new FakeChild();
    spawned.push(child);
    return child;
  },
}));

const { ProcessManager } = await import("../tasks/manager.js");

describe("managed server exit during startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    spawned.length = 0;
  });

  it("does not report a server as running when it exited just before the stay-alive deadline", async () => {
    vi.useFakeTimers();
    const manager = new ProcessManager();
    const starting = manager.startManagedServer({ command: "dies-late", cwd: tmpdir(), timeoutSec: 1 });
    const outcome = starting.then(
      (info) => ({ ok: true as const, info }),
      (error: Error) => ({ ok: false as const, error }),
    );

    await vi.advanceTimersByTimeAsync(950);
    const child = spawned[0]!;
    // Exit inside the final grace window; a descendant holds the pipes, so
    // "close" never fires and the status flip is still pending at the deadline.
    child.emit("exit", 7, null);
    child.stderr.emit("data", Buffer.from("boom: address in use\n"));
    await vi.advanceTimersByTimeAsync(5000);

    const result = await outcome;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("boom: address in use");
    expect(manager.listManagedServers()[0]!.status).not.toBe("running");
  });
});
