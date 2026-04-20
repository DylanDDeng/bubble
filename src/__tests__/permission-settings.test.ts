import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager, type RawSettings } from "../permissions/settings.js";

function writeJson(path: string, data: unknown) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

let bubbleHome: string;
let cwd: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "bubble-settings-"));
  bubbleHome = join(root, "home");
  cwd = join(root, "project");
  mkdirSync(bubbleHome, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  // mkdtemp contents are small; let the OS clean up /tmp.
});

function manager() {
  return new SettingsManager(cwd, { bubbleHome });
}

describe("SettingsManager — missing files", () => {
  it("returns empty merged view when no files exist", () => {
    const merged = manager().getMerged();
    expect(merged.defaultMode).toBeUndefined();
    expect(merged.ruleSet.allow).toEqual([]);
    expect(merged.ruleSet.deny).toEqual([]);
    expect(merged.diagnostics).toEqual([]);
  });

  it("exposes paths for each scope", () => {
    const m = manager();
    expect(m.getPath("user")).toBe(join(bubbleHome, "settings.json"));
    expect(m.getPath("project")).toBe(join(cwd, ".bubble", "settings.json"));
    expect(m.getPath("local")).toBe(join(cwd, ".bubble", "settings.local.json"));
  });
});

describe("SettingsManager — loading", () => {
  it("loads rules from user scope", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { allow: ["Bash(git status)"] },
    });
    const merged = manager().getMerged();
    expect(merged.ruleSet.allow.map((r) => r.source)).toEqual(["Bash(git status)"]);
  });

  it("concatenates allow rules across scopes", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { allow: ["Bash(git status)"] },
    });
    writeJson(join(cwd, ".bubble", "settings.json"), {
      permissions: { allow: ["Bash(npm test)"] },
    });
    writeJson(join(cwd, ".bubble", "settings.local.json"), {
      permissions: { allow: ["Bash(ls)"] },
    });

    const merged = manager().getMerged();
    const sources = merged.ruleSet.allow.map((r) => r.source);
    expect(sources).toContain("Bash(git status)");
    expect(sources).toContain("Bash(npm test)");
    expect(sources).toContain("Bash(ls)");
  });

  it("local defaultMode beats project beats user", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { defaultMode: "default" },
    });
    writeJson(join(cwd, ".bubble", "settings.json"), {
      permissions: { defaultMode: "acceptEdits" },
    });
    writeJson(join(cwd, ".bubble", "settings.local.json"), {
      permissions: { defaultMode: "plan" },
    });
    expect(manager().getMerged().defaultMode).toBe("plan");
  });

  it("project defaultMode beats user when no local", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { defaultMode: "default" },
    });
    writeJson(join(cwd, ".bubble", "settings.json"), {
      permissions: { defaultMode: "plan" },
    });
    expect(manager().getMerged().defaultMode).toBe("plan");
  });

  it("unknown defaultMode is dropped with a diagnostic", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { defaultMode: "yolo" },
    });
    const merged = manager().getMerged();
    expect(merged.defaultMode).toBeUndefined();
    expect(merged.diagnostics).toHaveLength(1);
    expect(merged.diagnostics[0].scope).toBe("user");
    expect(merged.diagnostics[0].message).toContain("yolo");
  });

  it("invalid rules produce diagnostics but valid ones still load", () => {
    writeJson(join(cwd, ".bubble", "settings.json"), {
      permissions: { allow: ["Bash()", "Bash(git status)"] },
    });
    const merged = manager().getMerged();
    expect(merged.ruleSet.allow.map((r) => r.source)).toEqual(["Bash(git status)"]);
    expect(merged.diagnostics).toHaveLength(1);
    expect(merged.diagnostics[0].scope).toBe("project");
  });

  it("broken JSON produces a diagnostic and does not throw", () => {
    const path = join(cwd, ".bubble", "settings.json");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(path, "{not valid json}", "utf-8");
    const merged = manager().getMerged();
    expect(merged.ruleSet.allow).toEqual([]);
    expect(merged.diagnostics[0].scope).toBe("project");
    expect(merged.diagnostics[0].message).toMatch(/parse/i);
  });

  it("non-object JSON is rejected", () => {
    const path = join(cwd, ".bubble", "settings.json");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(path, "[1, 2, 3]", "utf-8");
    const merged = manager().getMerged();
    expect(merged.diagnostics[0].message).toMatch(/object/i);
  });
});

describe("SettingsManager — addRule/removeRule", () => {
  it("creates the file and parent dir when adding to a missing scope", () => {
    const m = manager();
    const added = m.addRule("project", "allow", "Bash(git status)");
    expect(added).toBe(true);

    const raw = JSON.parse(readFileSync(m.getPath("project"), "utf-8")) as RawSettings;
    expect(raw.permissions?.allow).toEqual(["Bash(git status)"]);
  });

  it("writes atomically and shows up on next getMerged without reload", () => {
    const m = manager();
    m.addRule("local", "deny", "Bash(rm -rf:*)");
    const merged = m.getMerged();
    expect(merged.ruleSet.deny.map((r) => r.source)).toEqual(["Bash(rm -rf:*)"]);
  });

  it("does not duplicate when adding the same rule twice", () => {
    const m = manager();
    expect(m.addRule("user", "allow", "Bash(ls)")).toBe(true);
    expect(m.addRule("user", "allow", "Bash(ls)")).toBe(false);
    const raw = JSON.parse(readFileSync(m.getPath("user"), "utf-8")) as RawSettings;
    expect(raw.permissions?.allow).toEqual(["Bash(ls)"]);
  });

  it("removes by exact source string", () => {
    const m = manager();
    m.addRule("user", "allow", "Bash(ls)");
    m.addRule("user", "allow", "Bash(git status)");
    expect(m.removeRule("user", "allow", "Bash(ls)")).toBe(true);
    const raw = JSON.parse(readFileSync(m.getPath("user"), "utf-8")) as RawSettings;
    expect(raw.permissions?.allow).toEqual(["Bash(git status)"]);
  });

  it("returns false when removing a rule that isn't there", () => {
    const m = manager();
    expect(m.removeRule("user", "allow", "Bash(ls)")).toBe(false);
  });

  it("drops the list key when emptied by removeRule", () => {
    const m = manager();
    m.addRule("user", "allow", "Bash(ls)");
    m.removeRule("user", "allow", "Bash(ls)");
    const raw = JSON.parse(readFileSync(m.getPath("user"), "utf-8")) as RawSettings;
    expect(raw.permissions?.allow).toBeUndefined();
  });

  it("preserves other settings fields on write", () => {
    const path = join(cwd, ".bubble", "settings.json");
    writeJson(path, {
      somethingElse: { kept: true },
      permissions: { defaultMode: "plan", deny: ["Bash(rm -rf /)"] },
    });
    const m = manager();
    m.addRule("project", "allow", "Bash(git status)");
    const raw = JSON.parse(readFileSync(path, "utf-8")) as RawSettings & { somethingElse: unknown };
    expect(raw.somethingElse).toEqual({ kept: true });
    expect(raw.permissions?.defaultMode).toBe("plan");
    expect(raw.permissions?.deny).toEqual(["Bash(rm -rf /)"]);
    expect(raw.permissions?.allow).toEqual(["Bash(git status)"]);
  });
});

describe("SettingsManager — reload", () => {
  it("picks up external changes after reload", () => {
    const m = manager();
    expect(m.getMerged().ruleSet.allow).toEqual([]);

    writeJson(join(bubbleHome, "settings.json"), {
      permissions: { allow: ["Bash(whoami)"] },
    });
    // Without reload, cache is stale
    expect(m.getMerged().ruleSet.allow).toEqual([]);

    m.reload();
    expect(m.getMerged().ruleSet.allow.map((r) => r.source)).toEqual(["Bash(whoami)"]);
  });
});
