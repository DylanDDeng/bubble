import { describe, expect, it } from "vitest";
import { runHookCommand } from "../hooks/runner.js";
import type { HookEventEnvelope, LoadedHookRule } from "../hooks/types.js";

function rule(args: string[], overrides: Partial<LoadedHookRule> = {}): LoadedHookRule {
  return {
    id: "test-hook",
    events: ["PreToolUse"],
    command: {
      command: process.execPath,
      args,
    },
    timeoutMs: 1000,
    maxOutputBytes: 64 * 1024,
    enabled: true,
    onError: "allow",
    include: [],
    exposeToModel: false,
    inheritToSubagents: false,
    priority: 0,
    source: { scope: "user", path: "/tmp/settings.json", index: 0 },
    trusted: true,
    trustRequired: false,
    ...overrides,
  };
}

function envelope(): HookEventEnvelope {
  return {
    schemaVersion: 1,
    eventName: "PreToolUse",
    eventId: "event_1",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    agentRole: "parent",
    target: "Bash",
    payload: { name: "Bash" },
    redacted: [],
  };
}

describe("hook runner", () => {
  it("returns deny from JSON stdout", async () => {
    const result = await runHookCommand(rule([
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'blocked'})))",
    ]), envelope());

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("blocked");
  });

  it("treats exit code 2 as deny", async () => {
    const result = await runHookCommand(rule([
      "-e",
      "process.stderr.write('nope');process.exit(2)",
    ]), envelope());

    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("nope");
  });

  it("applies onError=block to timeouts", async () => {
    const result = await runHookCommand(rule([
      "-e",
      "setTimeout(()=>{}, 10000)",
    ], { timeoutMs: 50, onError: "block" }), envelope());

    expect(result.decision).toBe("deny");
    expect(result.error).toContain("timed out");
  });

  it("caps oversized stdout", async () => {
    const result = await runHookCommand(rule([
      "-e",
      "process.stdout.write('x'.repeat(100000))",
    ], { maxOutputBytes: 1024 }), envelope());

    expect(result.truncated).toBe(true);
    expect(result.stdout?.length).toBeLessThanOrEqual(1024);
  });
});
