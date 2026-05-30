import { describe, expect, it } from "vitest";
import {
  createStreamingInternalReminderSanitizer,
  formatInternalReminderBlock,
  sanitizeInternalReminderBlocks,
} from "../agent/internal-reminder-sanitizer.js";

describe("internal reminder sanitizer", () => {
  it("removes structured internal reminder blocks", () => {
    const input = [
      "before ",
      formatInternalReminderBlock("system-reminder", "Repository orientation workflow:\n- hidden"),
      " after",
    ].join("");

    expect(sanitizeInternalReminderBlocks(input)).toBe("before  after");
  });

  it("holds split structured tag blocks while streaming", () => {
    const sanitizer = createStreamingInternalReminderSanitizer();

    expect(sanitizer.push("before <bubble_internal_")).toBe("before ");
    expect(sanitizer.push("reminder kind=\"system-reminder\">\nsecret")).toBe("");
    expect(sanitizer.push("\n</bubble_internal_reminder> after")).toBe(" after");
    expect(sanitizer.flush()).toBe("");
  });

  it("holds partial runtime marker tails while streaming", () => {
    const sanitizer = createStreamingInternalReminderSanitizer();

    expect(sanitizer.push("normal Runtime ")).toBe("normal ");
    expect(sanitizer.push("cost is high")).toBe("Runtime cost is high");
    expect(sanitizer.flush()).toBe("");
  });

  it("removes split legacy runtime reminder blocks without emitting the marker prefix", () => {
    const sanitizer = createStreamingInternalReminderSanitizer();

    expect(sanitizer.push("before Runtime ")).toBe("before ");
    expect(sanitizer.push("reminder:\nRepository orientation workflow:\n")).toBe("");
    expect(sanitizer.push("- Start with the repo purpose and main execution paths.\n")).toBe("");
    expect(sanitizer.push("- Inspect README/package metadata plus core runtime files before summarizing.\n")).toBe("");
    expect(sanitizer.push("- Keep the first pass read-only unless the user asks for changes or runtime verification. after")).toBe(" after");
    expect(sanitizer.flush()).toBe("");
  });

  it("drops plan-mode legacy reminders that contain blank lines", () => {
    const input = `before Runtime reminder:
Plan mode is now ACTIVE.

Rules while in plan mode:
- Only read-only tools are allowed.
- On rejection, remain in plan mode and iterate.
 after`;

    expect(sanitizeInternalReminderBlocks(input)).toBe("before  after");
  });
});
