import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHookConfig } from "../hooks/config.js";
import { trustProjectHooks } from "../hooks/trust.js";
import { getProjectHookFingerprint } from "../hooks/config.js";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "bubble-hooks-config-"));
}

describe("hook config", () => {
  it("loads project hooks as untrusted until the current fingerprint is trusted", () => {
    const root = tmpRoot();
    const cwd = join(root, "repo");
    const bubbleHome = join(root, "home");
    const projectBubble = join(cwd, ".bubble");
    mkdirSync(projectBubble, { recursive: true });
    writeFileSync(join(projectBubble, "noop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(projectBubble, "settings.json"), JSON.stringify({
      hooks: {
        rules: [{
          id: "project-noop",
          event: "PreToolUse",
          matcher: "Bash",
          command: "./noop",
        }],
      },
    }, null, 2), "utf-8");

    let config = loadHookConfig({ cwd, bubbleHome });
    expect(config.projectTrust.required).toBe(true);
    expect(config.projectTrust.trusted).toBe(false);
    expect(config.rules[0]?.trusted).toBe(false);

    const fingerprint = getProjectHookFingerprint({ cwd, bubbleHome });
    expect(fingerprint).toBeTruthy();
    trustProjectHooks(fingerprint!, { bubbleHome });
    config = loadHookConfig({ cwd, bubbleHome });
    expect(config.projectTrust.trusted).toBe(true);
    expect(config.rules[0]?.trusted).toBe(true);

    writeFileSync(join(projectBubble, "settings.json"), JSON.stringify({
      hooks: {
        rules: [{
          id: "project-noop",
          event: "PreToolUse",
          matcher: "Read",
          command: "./noop",
        }],
      },
    }, null, 2), "utf-8");
    config = loadHookConfig({ cwd, bubbleHome });
    expect(config.projectTrust.trusted).toBe(false);
    expect(config.rules[0]?.trusted).toBe(false);
  });

  it("rejects project hooks that rely on PATH command lookup", () => {
    const root = tmpRoot();
    const cwd = join(root, "repo");
    const bubbleHome = join(root, "home");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(join(cwd, ".bubble", "settings.json"), JSON.stringify({
      hooks: {
        rules: [{
          id: "bad-project",
          event: "PreToolUse",
          command: "node",
        }],
      },
    }), "utf-8");

    const config = loadHookConfig({ cwd, bubbleHome });
    expect(config.rules).toHaveLength(0);
    expect(config.diagnostics.some((d) => d.message.includes("project hook command"))).toBe(true);
  });
});
