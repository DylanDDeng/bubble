import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createGlobTool } from "../glob.js";

describe("glob tool", () => {
  const root = join(tmpdir(), "bubble-test-glob-" + Date.now());
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1", "utf-8");
  writeFileSync(join(root, "src", "nested", "view.tsx"), "export const View = null", "utf-8");
  writeFileSync(join(root, "README.md"), "# demo", "utf-8");
  writeFileSync(join(root, "node_modules", "pkg", "ignored.ts"), "ignored", "utf-8");

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

  it("reports no_match when nothing matches", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.rs" }, { cwd: root });

    expect(result.status).toBe("no_match");
    expect(result.content).toContain("No files found");
  });
});
