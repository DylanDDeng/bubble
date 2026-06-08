import { describe, expect, it } from "vitest";
import { formatInternalReminderBlock } from "../agent/internal-reminder-sanitizer.js";
import type { DisplayMessage } from "../tui/display-history.js";
import { sanitizeDisplayMessage } from "../tui/display-sanitizer.js";

describe("TUI display sanitizer", () => {
  it("removes internal reminder blocks from assistant content and text parts", () => {
    const block = formatInternalReminderBlock("system-reminder", "hidden");
    const message: DisplayMessage = {
      role: "assistant",
      content: `before ${block} after`,
      parts: [
        { type: "text", content: block },
        { type: "text", content: `safe ${block} text` },
      ],
    };

    const sanitized = sanitizeDisplayMessage(message);

    expect(sanitized.content).toBe("before  after");
    expect(sanitized.parts).toEqual([
      { type: "text", content: "safe  text" },
    ]);
  });

  it("removes reasoning paragraphs that expose internal reminders", () => {
    const message: DisplayMessage = {
      role: "assistant",
      content: "",
      reasoning: [
        "normal before",
        "",
        "Actually, the system reminder at the top mentions:",
        "> The following deferred tools are available via tool_search.",
        "",
        "normal after",
      ].join("\n"),
    };

    const sanitized = sanitizeDisplayMessage(message);

    expect(sanitized.reasoning).toBe("normal before\n\nnormal after");
  });

  it("keeps ordinary MCP reasoning that does not expose the hidden reminder", () => {
    const message: DisplayMessage = {
      role: "assistant",
      content: "",
      reasoning: "The MCP arxiv search worked without any permission popup.",
    };

    expect(sanitizeDisplayMessage(message).reasoning).toBe(message.reasoning);
  });
});
