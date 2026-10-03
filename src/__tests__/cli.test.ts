import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enterWorkingDirectory, parseArgs } from "../cli.js";

describe("parseArgs", () => {
  it("does not set a default model anymore", () => {
    const args = parseArgs([]);
    expect(args.model).toBeUndefined();
  });

  it("does not expose no-session anymore", () => {
    const args = parseArgs(["--no-session"]);
    expect("noSession" in args).toBe(false);
  });

  it("parses resume and session flags", () => {
    const args = parseArgs(["--resume", "--session", "named.jsonl"]);
    expect(args.resume).toBe(true);
    expect(args.sessionName).toBe("named.jsonl");
  });

  it("parses ultra as a canonical reasoning effort", () => {
    expect(parseArgs(["--reasoning-effort", "ultra"]).thinkingLevel).toBe("ultra");
  });
});

describe("persistent CLI flags", () => {
  it("accepts paired stream formats in print mode", () => {
    expect(parseArgs(['-p','--input-format','stream-json','--output-format','stream-json']).inputFormat).toBe('stream-json');
  });
  it("rejects incompatible modes and interactive resume selection", () => {
    for (const args of [
      ['-p','--output-format','stream-json'],
      ['--input-format','stream-json','--output-format','stream-json'],
      ['-p','--input-format','stream-json','--output-format','stream-json','prompt'],
      ['-p','--input-format','stream-json','--output-format','stream-json','--resume'],
    ]) expect(()=>parseArgs(args)).toThrow();
  });
});

describe("--cwd", () => {
  it("resolves a relative --cwd to an absolute path", () => {
    expect(parseArgs(["--cwd", "../repo"]).cwd).toBe(resolve("../repo"));
    expect(parseArgs(["--cwd"]).cwd).toBe(process.cwd());
  });

  it("enters the directory, and reports a missing one without moving", () => {
    const start = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "bubble-cwd-"));
    const file = join(root, "file.txt");
    writeFileSync(file, "x");
    try {
      expect(enterWorkingDirectory(join(root, "missing"))).toMatch(/does not exist/);
      expect(enterWorkingDirectory(file)).toMatch(/is not a directory/);
      expect(process.cwd()).toBe(start);
      expect(enterWorkingDirectory(root)).toBeUndefined();
      expect(realpathSync(process.cwd())).toBe(realpathSync(root));
    } finally {
      process.chdir(start);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
