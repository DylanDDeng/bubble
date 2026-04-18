import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRelativeTime, getRecentSessions, truncatePreview } from "../tui/recent-activity.js";

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 3, 18, 12, 0, 0);
  it("reports just now under a minute", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
  });
  it("reports minutes", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  });
  it("reports hours", () => {
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
  });
  it("reports days", () => {
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe("2d ago");
  });
});

describe("truncatePreview", () => {
  it("returns first line unchanged when within limit", () => {
    expect(truncatePreview("short", 20)).toBe("short");
  });
  it("truncates long text with ellipsis", () => {
    expect(truncatePreview("a".repeat(30), 10)).toBe("aaaaaaaaa…");
  });
  it("returns only first line", () => {
    expect(truncatePreview("first\nsecond", 50)).toBe("first");
  });
});

describe("getRecentSessions", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-"));
    originalHome = process.env.BUBBLE_HOME;
    process.env.BUBBLE_HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.BUBBLE_HOME;
    else process.env.BUBBLE_HOME = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no sessions dir exists", () => {
    expect(getRecentSessions("/tmp/nonexistent-cwd", 5)).toEqual([]);
  });

  it("extracts first user message as preview and sorts newest first", async () => {
    const cwd = "/tmp/fake-project";
    const safeCwd = cwd.replace(/[/\\:]/g, "_");
    const sessionsDir = path.join(tmpDir, "sessions", safeCwd);
    await fs.mkdir(sessionsDir, { recursive: true });

    const oldFile = path.join(sessionsDir, "2026-04-10.jsonl");
    const newFile = path.join(sessionsDir, "2026-04-18.jsonl");

    await fs.writeFile(oldFile, JSON.stringify({
      id: "1", timestamp: 1, type: "user_message", message: { role: "user", content: "old question" },
    }) + "\n");
    await fs.writeFile(newFile, JSON.stringify({
      id: "1", timestamp: 1, type: "metadata", metadata: {},
    }) + "\n" + JSON.stringify({
      id: "2", timestamp: 2, type: "user_message", message: { role: "user", content: "new question" },
    }) + "\n");

    // Force newFile mtime to be later
    const now = Date.now();
    await fs.utimes(oldFile, now / 1000 - 1000, now / 1000 - 1000);
    await fs.utimes(newFile, now / 1000, now / 1000);

    const sessions = getRecentSessions(cwd, 5);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].preview).toBe("new question");
    expect(sessions[1].preview).toBe("old question");
  });
});
