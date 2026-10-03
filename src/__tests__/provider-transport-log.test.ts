import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logProviderTransportFailure, type ProviderTransportFailureContext } from "../network/provider-transport-log.js";

describe("persistent provider transport diagnostics", () => {
  let home: string;
  const context: ProviderTransportFailureContext = {
    providerId: "openai", modelId: "gpt-6-astra", thinkingLevel: "high", messageCount: 1, toolCount: 0,
    sessionId: "fixture-session", requestId: "fixture-request", attempt: 1, responseStatus: 200,
    receivedEvents: 2, elapsedMs: 42000, lastEventAgeMs: 1000, decision: "delegate_retry",
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bubble-transport-log-"));
    vi.stubEnv("BUBBLE_HOME", home);
    vi.stubEnv("BUBBLE_TRACE", "0");
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it("logs safe metadata without requiring debug tracing or copying raw error internals", () => {
    const error = new TypeError("terminated; private prompt", {
      cause: Object.assign(new Error("secret-token"), { code: "UND_ERR_SOCKET", headers: { Authorization: "private-key" } }),
    });
    logProviderTransportFailure(error, context);
    const file = join(home, "logs/provider-transport.jsonl");
    const raw = readFileSync(file, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      decision: "delegate_retry", responseStatus: 200, elapsedMs: 42000, lastEventAgeMs: 1000,
      error: { code: "UND_ERR_SOCKET", message: "Provider connection failed." },
    });
    expect(raw).not.toMatch(/private prompt|secret-token|private-key|Authorization|stack/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates bounded files and replaces the old backup", () => {
    mkdirSync(join(home, "logs"));
    const file = join(home, "logs/provider-transport.jsonl");
    writeFileSync(file, "x".repeat(2 * 1024 * 1024));
    writeFileSync(`${file}.1`, "old backup");
    logProviderTransportFailure(new Error("failure"), context);
    expect(statSync(`${file}.1`).size).toBe(2 * 1024 * 1024);
    expect(JSON.parse(readFileSync(file, "utf8")).requestId).toBe("fixture-request");
  });

  it("does not throw when the log directory cannot be created", () => {
    writeFileSync(join(home, "logs"), "not a directory");
    expect(() => logProviderTransportFailure(new Error("failure"), context)).not.toThrow();
  });
});
