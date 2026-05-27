import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureDebugTrace,
  resetDebugTraceForTests,
  summarizeTraceText,
  traceEvent,
} from "../debug-trace.js";

describe("debug trace", () => {
  const originalEnv = {
    BUBBLE_HOME: process.env.BUBBLE_HOME,
    BUBBLE_TRACE: process.env.BUBBLE_TRACE,
    BUBBLE_TRACE_PATH: process.env.BUBBLE_TRACE_PATH,
    BUBBLE_TRACE_RAW: process.env.BUBBLE_TRACE_RAW,
    BUBBLE_TRACE_RUN_ID: process.env.BUBBLE_TRACE_RUN_ID,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDebugTraceForTests();
  });

  it("stays disabled by default", () => {
    delete process.env.BUBBLE_TRACE;

    const info = configureDebugTrace({ cwd: "/tmp/project" });

    expect(info.enabled).toBe(false);
    expect(info.path).toBeUndefined();
  });

  it("writes summary-only jsonl under bubble home when enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-trace-home-"));
    process.env.BUBBLE_HOME = home;
    process.env.BUBBLE_TRACE = "1";
    process.env.BUBBLE_TRACE_RUN_ID = "unit-test-run";
    delete process.env.BUBBLE_TRACE_RAW;

    const info = configureDebugTrace({
      cwd: "/tmp/project",
      sessionFile: "/tmp/project/session.jsonl",
      provider: "openai",
      model: "openai:gpt-4o",
    });
    traceEvent("test_phase", {
      text: summarizeTraceText("hello trace"),
    });

    expect(info.enabled).toBe(true);
    expect(info.path).toBe(join(home, "debug-runs", new Date().toISOString().slice(0, 10), "unit-test-run.jsonl"));
    expect(existsSync(info.path!)).toBe(true);

    const line = JSON.parse(readFileSync(info.path!, "utf-8").trim());
    expect(line.phase).toBe("test_phase");
    expect(line.cwd).toBe("/tmp/project");
    expect(line.detail.text.chars).toBe(11);
    expect(line.detail.text.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(line.detail.text.raw).toBeUndefined();
  });

  it("includes raw payloads only when explicitly enabled", () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-trace-home-"));
    const path = join(home, "trace.jsonl");
    process.env.BUBBLE_TRACE = "1";
    process.env.BUBBLE_TRACE_PATH = path;
    process.env.BUBBLE_TRACE_RAW = "1";

    configureDebugTrace({ cwd: "/tmp/project" });
    traceEvent("raw_phase", {
      text: summarizeTraceText("raw value"),
    });

    const line = JSON.parse(readFileSync(path, "utf-8").trim());
    expect(line.detail.text.raw).toBe("raw value");
  });
});
