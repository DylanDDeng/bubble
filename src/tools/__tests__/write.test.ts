import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWriteTool } from "../write.js";

describe("write tool", () => {
  const tmpDir = join(tmpdir(), "bubble-test-write-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("writes a new file", async () => {
    const tool = createWriteTool(tmpDir, { refuseOverwrite: true });
    const result = await tool.execute(
      { path: "new.txt", content: "hello" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(tmpDir, "new.txt"), "utf-8")).toBe("hello");
  });

  it("refuses to overwrite existing file", async () => {
    const file = join(tmpDir, "existing.txt");
    readFileSync; // dummy
    const f = require("node:fs");
    f.writeFileSync(file, "old", "utf-8");

    const tool = createWriteTool(tmpDir, { refuseOverwrite: true });
    const result = await tool.execute(
      { path: "existing.txt", content: "new" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(f.readFileSync(file, "utf-8")).toBe("old");
  });
});
