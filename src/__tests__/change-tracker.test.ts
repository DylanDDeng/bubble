import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureGitBaseline, detectRunChanges, isTestFilePath } from "../agent/change-tracker.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "bubble-change-tracker-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "app.test.ts"), "line one\nline two\nline three\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

describe("change-tracker", () => {
  it("classifies test file paths", () => {
    expect(isTestFilePath("src/app.test.ts")).toBe(true);
    expect(isTestFilePath("tests/foo.py")).toBe(true);
    expect(isTestFilePath("src/__tests__/x.ts")).toBe(true);
    expect(isTestFilePath("parser/parser_test.go")).toBe(true); // Go suffix convention (the abs case)
    expect(isTestFilePath("spec/models/user_spec.rb")).toBe(true);
    expect(isTestFilePath("src/app.ts")).toBe(false);
    expect(isTestFilePath("src/contest.ts")).toBe(false);
  });

  it("attributes only run-time changes and flags modified pre-existing tests with deleted lines", async () => {
    const dir = initRepo();
    // Dirty BEFORE the run: must not be attributed to the run.
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");

    const baseline = await captureGitBaseline(dir);
    expect(baseline).not.toBeNull();

    // During the run: modify the pre-existing test (delete a line), create a
    // NEW test file, and write a new source file "via bash" (plain fs write).
    writeFileSync(join(dir, "app.test.ts"), "line one\nline three\n");
    writeFileSync(join(dir, "new-feature.test.ts"), "brand new test\n");
    writeFileSync(join(dir, "feature.ts"), "export const b = 1;\n");

    const changes = await detectRunChanges(dir, baseline);
    expect(changes).not.toBeNull();
    expect(changes!.changedFiles).toEqual(["app.test.ts", "feature.ts", "new-feature.test.ts"]);
    // Only the pre-existing test counts; the new test file is not suspect.
    expect(changes!.modifiedExistingTests).toEqual([{ path: "app.test.ts", deletedLines: 1 }]);
  });

  it("reports no changes when the run touched nothing", async () => {
    const dir = initRepo();
    const baseline = await captureGitBaseline(dir);
    const changes = await detectRunChanges(dir, baseline);
    expect(changes).toEqual({ changedFiles: [], modifiedExistingTests: [] });
  });

  it("counts appended-only test edits with zero deleted lines", async () => {
    const dir = initRepo();
    const baseline = await captureGitBaseline(dir);
    appendFileSync(join(dir, "app.test.ts"), "line four\n");
    const changes = await detectRunChanges(dir, baseline);
    expect(changes!.modifiedExistingTests).toEqual([{ path: "app.test.ts", deletedLines: 0 }]);
  });

  it("returns null outside a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-not-a-repo-"));
    expect(await captureGitBaseline(dir)).toBeNull();
  });
});
