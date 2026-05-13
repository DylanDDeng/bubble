import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileStateTracker } from "../file-state.js";
import { createReadTool } from "../read.js";
import { createWriteTool } from "../write.js";

describe("write tool", () => {
  const tmpDir = join(tmpdir(), "bubble-test-write-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  it("writes a new file", async () => {
    const tracker = new FileStateTracker(tmpDir);
    const tool = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);
    const result = await tool.execute(
      { path: "new.txt", content: "hello" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(tmpDir, "new.txt"), "utf-8")).toBe("hello");
  });

  it("refuses to overwrite existing file", async () => {
    const file = join(tmpDir, "existing.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const tool = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);
    const result = await tool.execute(
      { path: "existing.txt", content: "new" },
      { cwd: tmpDir }
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("already exists");
    expect(result.content).toContain("overwrite=true");
    expect(readFileSync(file, "utf-8")).toBe("old");
  });

  it("refuses overwrite=true until the file has been observed", async () => {
    const file = join(tmpDir, "unobserved.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const tool = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);
    const result = await tool.execute(
      { path: "unobserved.txt", content: "new", overwrite: true },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("has not been read or modified");
    expect(readFileSync(file, "utf-8")).toBe("old");
  });

  it("allows overwrite=true after a full read", async () => {
    const file = join(tmpDir, "observed.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const read = createReadTool(tmpDir, undefined, undefined, tracker);
    const write = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);

    await read.execute({ path: "observed.txt" }, { cwd: tmpDir });
    const result = await write.execute(
      { path: "observed.txt", content: "new", overwrite: true },
      { cwd: tmpDir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("new");
  });

  it("does not treat partial reads as safe for full-file overwrite", async () => {
    const file = join(tmpDir, "partial-read.txt");
    writeFileSync(file, "line1\nline2\nline3", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const read = createReadTool(tmpDir, undefined, undefined, tracker);
    const write = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);

    await read.execute({ path: "partial-read.txt", offset: 2, limit: 1 }, { cwd: tmpDir });
    const result = await write.execute(
      { path: "partial-read.txt", content: "new", overwrite: true },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("has not been read or modified");
    expect(readFileSync(file, "utf-8")).toBe("line1\nline2\nline3");
  });

  it("refuses overwrite=true when the file changed after it was read", async () => {
    const file = join(tmpDir, "stale.txt");
    writeFileSync(file, "old", "utf-8");

    const tracker = new FileStateTracker(tmpDir);
    const read = createReadTool(tmpDir, undefined, undefined, tracker);
    const write = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);

    await read.execute({ path: "stale.txt" }, { cwd: tmpDir });
    writeFileSync(file, "external change", "utf-8");
    const result = await write.execute(
      { path: "stale.txt", content: "new", overwrite: true },
      { cwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("changed since the last read/write/edit");
    expect(readFileSync(file, "utf-8")).toBe("external change");
  });

  it("allows overwrite=true after this session created the file", async () => {
    const file = join(tmpDir, "created-then-overwritten.txt");
    const tracker = new FileStateTracker(tmpDir);
    const write = createWriteTool(tmpDir, { refuseOverwrite: true }, undefined, undefined, tracker);

    const first = await write.execute(
      { path: "created-then-overwritten.txt", content: "first" },
      { cwd: tmpDir },
    );
    const second = await write.execute(
      { path: "created-then-overwritten.txt", content: "second", overwrite: true },
      { cwd: tmpDir },
    );

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("second");
  });
});
