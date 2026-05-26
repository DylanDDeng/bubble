import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../session.js";
import { sessionDisplayName } from "../tui/session-display.js";

describe("OpenTUI session display", () => {
  const tmpDir = join(tmpdir(), "bubble-test-opentui-session-display-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("uses stored session titles before jsonl filenames", () => {
    const sm = new SessionManager(join(tmpDir, "2026-05-26T00-00-00-000Z.jsonl"));
    sm.setMetadata({
      cwd: "/tmp/project",
      title: "Resume title polish",
      titleSource: "llm",
    });

    expect(sessionDisplayName(sm)).toBe("Resume title polish");
  });

  it("falls back to the session filename when no title is available", () => {
    const sm = new SessionManager(join(tmpDir, "fallback-name.jsonl"));

    expect(sessionDisplayName(sm)).toBe("fallback-name");
  });
});
