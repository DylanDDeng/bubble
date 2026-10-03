import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLsTool } from "../ls.js";
import { createBashTool } from "../bash.js";
import { createWorktreeChildTools } from "../child-tools.js";

describe("directory listing", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bubble-ls-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("shows all 49 sibling directories and two files regardless of nested file counts", async () => {
    const dirs = Array.from({ length: 49 }, (_, i) => `project-${String(i).padStart(2, "0")}`);
    await Promise.all(dirs.map((dir) => mkdir(join(root, dir))));
    await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(join(root, dirs[0]!, `${i}.txt`), "nested")));
    await writeFile(join(root, ".DS_Store"), "");
    await writeFile(join(root, "image-generation-mode.dshpreset"), "preset");
    const result = await createLsTool(root).execute({}, { cwd: root });
    expect(result.status).toBe("success");
    expect(result.metadata).toMatchObject({ matches: 51, totalEntries: 51, truncated: false });
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(51);
    expect(lines).toEqual(expect.arrayContaining(dirs.map((dir) => dir + "/")));
    expect(lines).toContain(".DS_Store");
    expect(lines).not.toContain("0.txt");
  });

  it("reports truncation and lets the caller increase the entry limit", async () => {
    await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(root, `file-${String(i).padStart(3, "0")}`), "")));
    const tool = createLsTool(root);
    const limited = await tool.execute({}, { cwd: root });
    expect(limited.status).toBe("partial");
    expect(limited.metadata).toMatchObject({ matches: 500, totalEntries: 501, truncated: true });
    expect(limited.content).toContain("Increase limit");
    const full = await tool.execute({ limit: 501 }, { cwd: root });
    expect(full.status).toBe("success");
    expect(full.metadata?.matches).toBe(501);
    expect(full.content).toContain("file-500");
  });

  it("bounds UTF-8 output independently of the entry limit", async () => {
    await Promise.all(Array.from({ length: 300 }, (_, i) => writeFile(join(root, `${i}-${"猫".repeat(70)}`), "")));
    const result = await createLsTool(root).execute({ limit: 1000 }, { cwd: root });
    expect(result.status).toBe("partial");
    expect(result.content).toContain("50 KiB");
    expect(result.content).toContain("filter or page");
    expect(Buffer.byteLength(result.content.split("\n\n[")[0]!)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content).not.toContain("�");
  });

  it("resolves relative and absolute paths and preserves empty-directory results", async () => {
    await mkdir(join(root, "child"));
    const tool = createLsTool(root);
    for (const path of ["child", join(root, "child")]) {
      const result = await tool.execute({ path }, { cwd: "/unrelated" });
      expect(result.status).toBe("success");
      expect(result.content).toBe("(empty directory)");
      expect(result.metadata).toMatchObject({ path: join(root, "child"), matches: 0, truncated: false });
    }
  });

  it("shows hidden directories and broken or directory symlinks without following them", async () => {
    await mkdir(join(root, ".hidden"));
    await symlink(".hidden", join(root, "link"));
    await symlink("missing", join(root, "broken"));
    const result = await createLsTool(root).execute({}, { cwd: root });
    expect(result.content).toBe(".hidden/\nbroken@\nlink@");
    expect(result.status).toBe("success");
  });

  it("reports file and missing paths as errors, not empty directories", async () => {
    await writeFile(join(root, "file"), "");
    for (const path of ["file", "missing"]) {
      const result = await createLsTool(root).execute({ path }, { cwd: root });
      expect(result.isError).toBe(true);
      expect(result.status).toBe("command_error");
    }
  });

  it.each([0, -1, 1.5, "2", Infinity])("rejects invalid limit %s", async (limit) => {
    const result = await createLsTool(root).execute({ limit }, { cwd: root });
    expect(result.status).toBe("command_error");
  });

  it("reports cancellation instead of a complete listing", async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await createLsTool(root).execute({}, { cwd: root, abortSignal: abort.signal });
    expect(result.status).toBe("cancelled");
    expect(result.isError).toBe(true);
  });

  it("binds the child's ls to its worktree directory", async () => {
    await mkdir(join(root, "worktree"));
    await writeFile(join(root, "parent-only"), "");
    await writeFile(join(root, "worktree", "child-only"), "");
    const tools = createWorktreeChildTools(join(root, "worktree"), ["ls"]);
    expect(tools.map((tool) => tool.name)).toEqual(["ls"]);
    const result = await tools[0]!.execute({}, { cwd: root });
    expect(result.content).toBe("child-only");
  });

  it("also permits ls, find and rg through bash with their requested options", async () => {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "README.md"), "Bubble search fixture");
    const bash = createBashTool(root);
    for (const [command, expected] of [
      ["ls -a", "nested"],
      ["find . -type d", "./nested"],
      ["rg -n -i 'bubble' README.md", "1:Bubble search fixture"],
    ]) {
      const result = await bash.execute({ command }, { cwd: root });
      expect(result.isError, result.content).toBe(false);
      expect(result.content).toContain(expected);
    }
  });
});
