import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createGlobTool } from "../glob.js";

describe("glob tool", () => {
  const root = join(tmpdir(), "bubble-test-glob-" + Date.now());
  const outsideRoot = join(tmpdir(), "bubble-test-glob-outside-" + Date.now());
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1", "utf-8");
  writeFileSync(join(root, "src", "nested", "view.tsx"), "export const View = null", "utf-8");
  writeFileSync(join(root, "README.md"), "# demo", "utf-8");
  writeFileSync(join(root, "node_modules", "pkg", "ignored.ts"), "ignored", "utf-8");
  writeFileSync(join(outsideRoot, "outside.md"), "# outside", "utf-8");

  it("finds files by glob pattern", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.ts" }, { cwd: root });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("src/index.ts");
    expect(result.content).not.toContain("ignored.ts");
    expect(result.metadata?.kind).toBe("search");
  });

  it("supports a scoped search path", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*", path: "src/nested" }, { cwd: root });

    expect(result.content).toContain("view.tsx");
    expect(result.content).not.toContain("README.md");
  });

  it("normalizes absolute patterns under cwd", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: join(root, "README*") }, { cwd: root });

    expect(result.status).toBe("success");
    expect(result.content).toContain("README.md");
    expect(result.metadata?.originalPattern).toBe(join(root, "README*"));
    expect(result.metadata?.normalizedPattern).toBe("README*");
    expect(result.metadata?.searchSignature).toBe(`glob:${root}:README*`);
  });

  it("normalizes absolute patterns relative to the active search root", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: join(root, "src", "**", "*.tsx"), path: "src" }, { cwd: root });

    expect(result.status).toBe("success");
    expect(result.content).toContain("nested/view.tsx");
    expect(result.content).not.toContain("src/nested/view.tsx");
    expect(result.metadata?.normalizedPattern).toBe("**/*.tsx");
  });

  it("lets an absolute pattern choose a search root outside cwd", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: join(outsideRoot, "*.md"), path: "src" }, { cwd: root });

    expect(result.status).toBe("success");
    expect(result.content).toContain("outside.md");
    expect(result.metadata?.path).toBe(outsideRoot);
    expect(result.metadata?.normalizedPattern).toBe("*.md");
  });

  it("reports relative patterns that escape the search path as command errors", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "../*.md", path: "src" }, { cwd: root });

    expect(result.status).toBe("command_error");
    expect(result.content).toContain("must stay within the search path");
  });

  it("reports no_match when nothing matches", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.rs" }, { cwd: root });

    expect(result.status).toBe("no_match");
    expect(result.content).toContain("No files found");
  });
});
