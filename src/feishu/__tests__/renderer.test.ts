import { describe, expect, it } from "vitest";
import { renderCard } from "../card/renderer.js";
import { createInitialRunState, type RunState } from "../card/run-state-types.js";

function makeState(): RunState {
  const state = createInitialRunState({
    scope: { chatId: "oc_test", userId: "ou_test", displayName: "test", cwd: "/tmp/test" },
    mode: "default",
  });
  state.blocks.push(
    { kind: "thinking", text: "inspect code\nconsider release", streaming: false },
    {
      kind: "tool",
      id: "tool_1",
      name: "Read",
      argsPreview: "path=/tmp/test/src/feishu/card/renderer.ts and more context",
      status: "ok",
      resultPreview: "renderer output",
      startedAt: 1,
      endedAt: 2,
    },
  );
  return state;
}

function collectTags(value: unknown, tags: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTags(item, tags);
    return tags;
  }
  if (!value || typeof value !== "object") return tags;
  const record = value as Record<string, unknown>;
  if (typeof record.tag === "string") tags.push(record.tag);
  for (const child of Object.values(record)) collectTags(child, tags);
  return tags;
}

function collectMarkdown(value: unknown, chunks: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectMarkdown(item, chunks);
    return chunks;
  }
  if (!value || typeof value !== "object") return chunks;
  const record = value as Record<string, unknown>;
  if (record.tag === "markdown" && typeof record.content === "string") {
    chunks.push(record.content);
  }
  for (const child of Object.values(record)) collectMarkdown(child, chunks);
  return chunks;
}

describe("Feishu card renderer", () => {
  const budget = { maxBytesPerElement: 5000, maxBytesPerCard: 20_000 };

  it("uses collapsible panels for thinking and completed tool details by default", () => {
    const card = renderCard(makeState(), { budget });
    const tags = collectTags(card);
    expect(tags.filter((tag) => tag === "collapsible_panel")).toHaveLength(2);
    expect(collectMarkdown(card).join("\n")).toContain("renderer output");
  });

  it("can render without collapsible panels for older Feishu card hosts", () => {
    const card = renderCard(makeState(), { budget, collapsible: false });
    const tags = collectTags(card);
    const markdown = collectMarkdown(card).join("\n");
    expect(tags).not.toContain("collapsible_panel");
    expect(markdown).toContain("renderer output");
    expect(markdown).not.toContain("inspect code");
  });
});
