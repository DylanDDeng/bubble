import { describe, expect, it, vi } from "vitest";
import { buildCompactionPromptMessages, serializeTranscript } from "../context/compact-llm.js";
import { compactWithLLM, LLM_SUMMARY_PREFIX } from "../context/llm-compactor.js";
import { COMPACTION_SUMMARY_PREFIX, SUBTURN_SUMMARY_PREFIX } from "../context/compact.js";
import type { Message, Provider } from "../types.js";

const summaryCarriers: Message[] = [
  { role: "meta", kind: "compaction-summary", content: "prior decision" },
  { role: "meta", kind: "subturn-compaction-summary", content: "prior decision" },
  { role: "system", content: `${COMPACTION_SUMMARY_PREFIX}\nprior decision` },
  { role: "system", content: `${SUBTURN_SUMMARY_PREFIX}\nprior decision` },
  { role: "user", content: `${LLM_SUMMARY_PREFIX}\nprior decision` },
  { role: "user", content: '<bubble_internal_context kind="compaction-summary">\nprior decision\n</bubble_internal_context>' },
  { role: "user", content: '<bubble_internal_context kind="subturn-compaction-summary">\nprior decision\n</bubble_internal_context>' },
  { role: "user", content: `<bubble_internal_context kind="runtime-system">\n${COMPACTION_SUMMARY_PREFIX}\nprior decision\n</bubble_internal_context>` },
  { role: "user", content: `<bubble_internal_context kind="runtime-system">\n${SUBTURN_SUMMARY_PREFIX}\nprior decision\n</bubble_internal_context>` },
];

const reminders: Message[] = [
  { role: "meta", kind: "system-reminder", includeInLlm: false, content: "expired reminder" },
  { role: "meta", kind: "runtime-context", includeInLlm: false, content: "expired runtime context" },
  { role: "meta", kind: "system-reminder", includeInLlm: true, content: "active reminder" },
  { role: "meta", kind: "runtime-context", content: "active runtime context" },
];

describe("automatic compaction input visibility", () => {
  it.each(["prior turn", "current turn"])("excludes expired reminders in the %s without losing summaries or visible context", async (position) => {
    const complete = vi.fn<Provider["complete"]>(async () => "merged summary");
    const provider: Provider = { complete, async *streamChat() {} };
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      summaryCarriers[0],
      { role: "user", content: "original instruction" },
      { role: "assistant", content: "earlier work" },
      ...(position === "prior turn" ? reminders : []),
      { role: "user", content: "current instruction" },
      { role: "assistant", content: "current work" },
      ...(position === "current turn" ? reminders : []),
    ];

    const result = await compactWithLLM(messages, { provider, modelId: "fake", keepRecentGroups: 0 });

    expect(result.compacted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    const input = complete.mock.calls[0][0][1].content;
    expect(input).toContain("prior decision");
    expect(input).toContain("earlier work");
    expect(input).toContain("current work");
    expect(input).toContain("active reminder");
    expect(input).toContain("active runtime context");
    expect(input).not.toContain("expired reminder");
    expect(input).not.toContain("expired runtime context");
  });
});

describe("manual compaction summary preservation", () => {
  it.each(summaryCarriers)("preserves the existing summary carrier %#", (summary) => {
    const messages: Message[] = [
      { role: "system", content: "ordinary system prompt" },
      ...reminders,
      summary,
      { role: "user", content: "continue the task" },
      { role: "assistant", content: "recent progress" },
    ];

    const transcript = serializeTranscript(messages);
    const prompt = buildCompactionPromptMessages(messages);
    expect(transcript).toContain("[Prior compaction summary]");
    expect(transcript.match(/prior decision/g)).toHaveLength(1);
    expect(prompt[1].content).toContain(transcript);
    expect(transcript).toContain("[user] continue the task");
    expect(transcript).toContain("[assistant] recent progress");
    expect(transcript).not.toContain("ordinary system prompt");
    for (const reminder of reminders) expect(transcript).not.toContain(reminder.content);
  });
});
