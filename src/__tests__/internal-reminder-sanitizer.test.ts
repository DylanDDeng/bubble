import { wrapInSystemReminder } from "../prompt/reminders.js";
import { describe, expect, it } from "vitest";
import {
  createStreamingInternalReminderSanitizer,
  formatInternalReminderBlock,
  sanitizeAssistantProviderMetadata,
  sanitizeInternalReasoningText,
  sanitizeInternalReminderBlocks,
} from "../agent/internal-reminder-sanitizer.js";

// The exact block a user saw leak in a released build (debugging task reminder,
// projected into the system-reminder wrapper sent to the model).
const OBSERVED_LEAK_BLOCK = `<bubble_internal_reminder kind="system-reminder">
Debugging workflow:
- Reproduce or identify the failing boundary before editing.
- Trace input, transformation, and output paths.
- Prefer fixing the mechanism over raising thresholds or adding superficial fallbacks.
- Verify the specific failure path after the change.
</bubble_internal_reminder>`;

describe("internal reminder sanitizer", () => {
  it("removes structured internal reminder blocks", () => {
    const input = [
      "before ",
      formatInternalReminderBlock("system-reminder", "Repository orientation workflow:\n- hidden"),
      " after",
    ].join("");

    expect(sanitizeInternalReminderBlocks(input)).toBe("before  after");
  });

  it("removes memory citation blocks", () => {
    const input = [
      "before\n",
      "<oai-mem-citation>\n",
      "<citation_entries>\n",
      "/Users/example/.bubble/memories/MEMORY.md:1-2|note=[used memory]\n",
      "</citation_entries>\n",
      "<rollout_ids>\n",
      "</rollout_ids>\n",
      "</oai-mem-citation>\n",
      "after",
    ].join("");

    expect(sanitizeInternalReminderBlocks(input)).toBe("before\nafter");
  });

  it("holds split memory citation blocks while streaming", () => {
    const sanitizer = createStreamingInternalReminderSanitizer();

    expect(sanitizer.push("done\n<oai-mem-")).toBe("done\n");
    expect(sanitizer.push("citation>\n/Users/example/file.md\n")).toBe("");
    expect(sanitizer.push("</oai-mem-citation>\nnext")).toBe("next");
    expect(sanitizer.flush()).toBe("");
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

  it("removes reworded loop reminders by structured tag rather than content", () => {
    // Inline replica of the removed governor loop-warning shape: the
    // sanitizer strips by structured tag, so any reworded body must pass.
    const reminder = wrapInSystemReminder(
      "Further broad exploration is low value.\n\nThis task has already used many search steps.\n\nDo not repeat near-identical reads or searches.",
    );
    const input = [
      "before ",
      formatInternalReminderBlock("system-reminder", reminder),
      " after",
    ].join("");

    expect(reminder).not.toContain("Tool loop warning");
    expect(sanitizeInternalReminderBlocks(input)).toBe("before  after");
  });

  it("removes reasoning paragraphs that expose deferred tool reminders", () => {
    const input = [
      "normal before",
      "",
      "Actually, the system reminder at the top mentions:\n",
      "> The following deferred tools are available via tool_search. Their schemas are NOT loaded.",
      "",
      "normal after",
    ].join("\n");

    expect(sanitizeInternalReasoningText(input)).toBe("normal before\n\nnormal after");
  });

  it("removes reasoning paragraphs that expose subagent lifecycle reminders", () => {
    const input = [
      "normal before",
      "",
      "Subagent lifecycle truth:",
      "- Unique subagents currently tracked: 1.",
      "- Count unique agent_id values only.",
      "",
      "normal after",
    ].join("\n");

    expect(sanitizeInternalReasoningText(input)).toBe("normal before\n\nnormal after");
  });

  it("strips the exact observed leak block when streamed one byte at a time", () => {
    const sanitizer = createStreamingInternalReminderSanitizer();
    let out = "";
    for (const char of `before\n${OBSERVED_LEAK_BLOCK}\nafter`) {
      out += sanitizer.push(char);
    }
    out += sanitizer.flush();
    // The block is fully stripped; only the surrounding text survives. (Exact
    // whitespace between can vary in pure streaming because the block closes
    // before its trailing newline arrives — what matters is zero leakage.)
    expect(out).not.toContain("Debugging workflow");
    expect(out).not.toContain("bubble_internal_reminder");
    expect(out.replace(/\n+/g, "\n")).toBe("before\nafter");
  });
});

describe("sanitizeAssistantProviderMetadata", () => {
  function meta(contentBlocks: unknown[]) {
    return { anthropic: { contentBlocks } } as any;
  }

  it("strips internal markup from plaintext text blocks", () => {
    const out = sanitizeAssistantProviderMetadata(
      meta([{ type: "text", text: `hi ${OBSERVED_LEAK_BLOCK} bye` }]),
    );
    const block = out!.anthropic!.contentBlocks![0] as any;
    expect(block.type).toBe("text");
    expect(block.text).not.toContain("bubble_internal_reminder");
    expect(block.text).not.toContain("Debugging workflow");
  });

  it("drops a signed thinking block whose text carries an echoed reminder", () => {
    const out = sanitizeAssistantProviderMetadata(
      meta([
        { type: "thinking", thinking: `I recall: ${OBSERVED_LEAK_BLOCK}`, signature: "sig-abc" },
        { type: "tool_use", id: "t1", name: "read", input: {} },
      ]),
    );
    const blocks = out!.anthropic!.contentBlocks!;
    // The thinking block cannot be rewritten without invalidating its
    // signature, so it is removed entirely; the tool_use block survives.
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).type).toBe("tool_use");
    expect(JSON.stringify(out)).not.toContain("bubble_internal_reminder");
    expect(JSON.stringify(out)).not.toContain("Debugging workflow");
  });

  it("leaves a clean thinking block (and its signature) untouched", () => {
    const input = meta([
      { type: "thinking", thinking: "Let me check the parser first.", signature: "sig-xyz" },
    ]);
    const out = sanitizeAssistantProviderMetadata(input);
    // No internal markup anywhere, so the metadata object is returned as-is.
    expect(out).toBe(input);
    const block = out!.anthropic!.contentBlocks![0] as any;
    expect(block.thinking).toBe("Let me check the parser first.");
    expect(block.signature).toBe("sig-xyz");
  });

  it("leaves redacted_thinking blocks intact (no plaintext field to scan)", () => {
    const input = meta([{ type: "redacted_thinking", data: "EncRypTeDdata==" }]);
    const out = sanitizeAssistantProviderMetadata(input);
    expect(out).toBe(input);
    expect((out!.anthropic!.contentBlocks![0] as any).data).toBe("EncRypTeDdata==");
  });
});
