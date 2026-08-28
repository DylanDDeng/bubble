import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendHistoryEntry,
  loadHistoryEntriesSync,
  loadHistorySync,
  pushHistoryEntry,
  stepHistory,
  type HistoryEntry,
  type HistoryImageAttachment,
} from "../tui/model/input-history.js";

function tempHistoryFile(): string {
  return join(mkdtempSync(join(tmpdir(), "bubble-history-")), "input-history.jsonl");
}

function image(name = "image.png"): HistoryImageAttachment {
  const base64 = "aGVsbG8=";
  return {
    mediaType: "image/png",
    bytes: 5,
    base64,
    dataUrl: `data:image/png;base64,${base64}`,
    filename: name,
  };
}

describe("input history navigation", () => {
  const history = ["first", "second", "third"];

  it("up from draft snapshots current text and shows newest entry", () => {
    const result = stepHistory({ history, index: null, draft: "" }, "up", "draft-in-progress");
    expect(result).toEqual({
      text: "third",
      index: 2,
      draft: "draft-in-progress",
      changed: true,
    });
  });

  it("up walks backwards without overwriting saved draft", () => {
    const result = stepHistory({ history, index: 2, draft: "draft" }, "up", "third-edited");
    expect(result.text).toBe("second");
    expect(result.index).toBe(1);
    expect(result.draft).toBe("draft");
    expect(result.changed).toBe(true);
  });

  it("up at oldest entry is a no-op", () => {
    const result = stepHistory({ history, index: 0, draft: "draft" }, "up", "first");
    expect(result.changed).toBe(false);
    expect(result.index).toBe(0);
  });

  it("up with empty history is a no-op", () => {
    const result = stepHistory({ history: [], index: null, draft: "" }, "up", "anything");
    expect(result.changed).toBe(false);
  });

  it("down moves forward through history", () => {
    const result = stepHistory({ history, index: 0, draft: "draft" }, "down", "first");
    expect(result.text).toBe("second");
    expect(result.index).toBe(1);
  });

  it("down past newest restores the saved draft and clears it", () => {
    const result = stepHistory({ history, index: 2, draft: "draft" }, "down", "third");
    expect(result.text).toBe("draft");
    expect(result.index).toBeNull();
    expect(result.draft).toBe("");
    expect(result.changed).toBe(true);
  });

  it("down past newest with empty draft yields blank composer", () => {
    const result = stepHistory({ history, index: 2, draft: "" }, "down", "third");
    expect(result.text).toBe("");
    expect(result.index).toBeNull();
    expect(result.changed).toBe(true);
  });

  it("down while editing a draft is a no-op", () => {
    const result = stepHistory({ history, index: null, draft: "" }, "down", "typing");
    expect(result.changed).toBe(false);
    expect(result.text).toBe("typing");
  });

  it("restores images from history entries", () => {
    const picture = image("attached.png");
    const history: HistoryEntry[] = [
      { text: "look at this", images: [picture], imageDisplayStart: 3 },
    ];

    const result = stepHistory({ history, index: null, draft: "" }, "up", "");

    expect(result.text).toBe("look at this");
    expect(result.images).toEqual([picture]);
    expect(result.imageDisplayStart).toBe(3);
  });

  it("restores image drafts after walking back down past newest history", () => {
    const draftImage = image("draft.png");
    const result = stepHistory(
      {
        history: [{ text: "previous", images: [] }],
        index: 0,
        draft: { text: "draft", images: [draftImage], imageDisplayStart: 8 },
      },
      "down",
      "previous",
    );

    expect(result.text).toBe("draft");
    expect(result.images).toEqual([draftImage]);
    expect(result.imageDisplayStart).toBe(8);
    expect(result.index).toBeNull();
  });
});

describe("pushHistoryEntry", () => {
  it("appends a new entry", () => {
    expect(pushHistoryEntry(["a"], "b")).toEqual(["a", "b"]);
  });

  it("dedupes consecutive identical entries", () => {
    const history = ["a", "b"];
    expect(pushHistoryEntry(history, "b")).toBe(history);
  });

  it("ignores empty / whitespace-only entries", () => {
    const history = ["a"];
    expect(pushHistoryEntry(history, "")).toBe(history);
    expect(pushHistoryEntry(history, "   \n  ")).toBe(history);
  });

  it("keeps non-consecutive duplicates", () => {
    expect(pushHistoryEntry(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });

  it("dedupes consecutive image entries by text and image data", () => {
    const entry: HistoryEntry = { text: "same", images: [image()] };
    const history = [entry];

    expect(pushHistoryEntry(history, { text: "same", images: [image()] })).toBe(history);
    expect(pushHistoryEntry(history, { text: "same", images: [image("other.png")] })).not.toBe(history);
  });
});

describe("scoped input history persistence", () => {
  it("loads only entries from the current session", () => {
    const filePath = tempHistoryFile();
    writeFileSync(filePath, [
      JSON.stringify("legacy global"),
      JSON.stringify({ text: "session a first", sessionFile: "/sessions/a.jsonl", cwd: "/repo" }),
      JSON.stringify({ text: "session b", sessionFile: "/sessions/b.jsonl", cwd: "/repo" }),
      JSON.stringify({ text: "session a second", sessionFile: "/sessions/a.jsonl", cwd: "/other" }),
      JSON.stringify({ text: "cwd only", cwd: "/repo" }),
    ].join("\n") + "\n");

    expect(loadHistorySync({
      filePath,
      scope: { sessionFile: "/sessions/a.jsonl", cwd: "/repo" },
    })).toEqual(["session a first", "session a second"]);
  });

  it("excludes legacy global entries when a session scope is supplied", () => {
    const filePath = tempHistoryFile();
    writeFileSync(filePath, [
      JSON.stringify("legacy global"),
      JSON.stringify({ text: "scoped", sessionFile: "/sessions/current.jsonl" }),
    ].join("\n") + "\n");

    expect(loadHistorySync({
      filePath,
      scope: { sessionFile: "/sessions/current.jsonl" },
    })).toEqual(["scoped"]);
  });

  it("keeps backward-compatible unscoped reads", () => {
    const filePath = tempHistoryFile();
    writeFileSync(filePath, [
      JSON.stringify("legacy global"),
      JSON.stringify({ text: "new scoped", sessionFile: "/sessions/current.jsonl" }),
    ].join("\n") + "\n");

    expect(loadHistorySync(filePath)).toEqual(["legacy global", "new scoped"]);
  });

  it("persists new entries with session metadata", () => {
    const filePath = tempHistoryFile();

    appendHistoryEntry("hello", {
      filePath,
      scope: { sessionFile: "/sessions/current.jsonl", cwd: "/repo" },
      createdAt: "2026-06-19T00:00:00.000Z",
    });

    expect(loadHistorySync({
      filePath,
      scope: { sessionFile: "/sessions/current.jsonl" },
    })).toEqual(["hello"]);

    const raw = readFileSync(filePath, "utf8").trim();
    expect(JSON.parse(raw)).toEqual({
      text: "hello",
      createdAt: "2026-06-19T00:00:00.000Z",
      sessionFile: "/sessions/current.jsonl",
      cwd: "/repo",
    });
  });

  it("persists and restores image attachments for session history", () => {
    const filePath = tempHistoryFile();
    const picture = image("screenshot.png");

    appendHistoryEntry({
      text: "what is in this image",
      images: [picture],
      imageDisplayStart: 4,
    }, {
      filePath,
      scope: { sessionFile: "/sessions/current.jsonl" },
      createdAt: "2026-06-19T00:00:00.000Z",
    });

    expect(loadHistoryEntriesSync({
      filePath,
      scope: { sessionFile: "/sessions/current.jsonl" },
    })).toEqual([
      {
        text: "what is in this image",
        images: [picture],
        imageDisplayStart: 4,
      },
    ]);

    const raw = JSON.parse(readFileSync(filePath, "utf8").trim());
    expect(raw.images).toEqual([{
      mediaType: picture.mediaType,
      bytes: picture.bytes,
      dataUrl: picture.dataUrl,
      filename: picture.filename,
    }]);
    expect(raw.images[0].base64).toBeUndefined();
    expect(raw.imageDisplayStart).toBe(4);
  });
});
