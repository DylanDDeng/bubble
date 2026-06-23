import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../session.js";
import { buildSessionPickerEntries, preferredSessionPickerIndex } from "../tui/session-picker-data.js";

const NOW = Date.parse("2026-06-13T12:00:00Z");

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    file: "/home/u/.bubble/sessions/_proj/2026-06-13T10-00-00-000Z.jsonl",
    name: "2026-06-13T10-00-00-000Z",
    cwd: "/proj",
    cwdLabel: "proj",
    title: "Fix the login flow",
    preview: "help me fix login",
    firstUserMessage: "help me fix login",
    messageCount: 12,
    mtime: NOW - 2 * 3600 * 1000,
    ...overrides,
  };
}

describe("buildSessionPickerEntries", () => {
  it("maps summaries to picker entries with title, count, and relative time", () => {
    const [entry] = buildSessionPickerEntries([summary()], undefined, NOW);
    expect(entry).toEqual({
      label: "Fix the login flow",
      detail: "12 messages",
      value: "/home/u/.bubble/sessions/_proj/2026-06-13T10-00-00-000Z.jsonl",
      footer: "2h ago",
      gutter: undefined,
    });
  });

  it("marks the active session with a gutter dot and 'current' footer", () => {
    const active = summary();
    const [entry] = buildSessionPickerEntries([active], active.file, NOW);
    expect(entry.gutter).toBe("●");
    expect(entry.footer).toBe("current");
  });

  it("falls back to preview, then filename, for untitled sessions", () => {
    const [fromPreview] = buildSessionPickerEntries([summary({ title: "" })], undefined, NOW);
    expect(fromPreview.label).toBe("help me fix login");

    const [fromName] = buildSessionPickerEntries([summary({ title: "", preview: "" })], undefined, NOW);
    expect(fromName.label).toBe("2026-06-13T10-00-00-000Z");
  });

  it("flattens multi-line titles and pluralizes the message count", () => {
    const [entry] = buildSessionPickerEntries(
      [summary({ title: "line one\nline two", messageCount: 1 })],
      undefined,
      NOW,
    );
    expect(entry.label).not.toContain("\n");
    expect(entry.detail).toBe("1 message");
  });
});

describe("preferredSessionPickerIndex", () => {
  it("prefers the most recent non-current session", () => {
    const active = summary();
    const other = summary({ file: "/other.jsonl", name: "other" });
    const entries = buildSessionPickerEntries([active, other], active.file, NOW);
    expect(preferredSessionPickerIndex(entries)).toBe(1);
  });

  it("falls back to the first row when only the current session exists", () => {
    const active = summary();
    const entries = buildSessionPickerEntries([active], active.file, NOW);
    expect(preferredSessionPickerIndex(entries)).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(preferredSessionPickerIndex([])).toBe(0);
  });
});
