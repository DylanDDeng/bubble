import { describe, expect, it, vi } from "vitest";
import { ResponsiveTranscriptComponent } from "../tui/components/responsive-transcript.js";
import { buildTraceGroups } from "../tui/model/trace-groups.js";
import { TraceInteractionState } from "../tui/model/trace-interaction.js";
import type { DisplayMessage, DisplayToolCall } from "../tui/model/display-history.js";
import { reconstructDisplayMessages } from "../tui/model/display-reconstruct.js";

describe("ResponsiveTranscriptComponent projection cache", () => {
  it("reuses settled projection across composer-only frames", () => {
    let messages: readonly DisplayMessage[] = [{ key: "a", role: "assistant", content: "hello" }];
    const markdownRenderer = vi.fn((text: string) => [text]);
    let showReasoning = false;
    const component = new ResponsiveTranscriptComponent(() => ({
      messages,
      options: { markdownRenderer, showReasoning },
    }));

    component.render(100);
    component.render(100);
    expect(markdownRenderer).toHaveBeenCalledTimes(1);

    component.render(80);
    expect(markdownRenderer).toHaveBeenCalledTimes(2);

    messages = [...messages];
    component.render(80);
    expect(markdownRenderer).toHaveBeenCalledTimes(3);

    showReasoning = true;
    component.render(80);
    expect(markdownRenderer).toHaveBeenCalledTimes(4);

    component.invalidate();
    component.render(80);
    expect(markdownRenderer).toHaveBeenCalledTimes(5);
  });

  it("invalidates cached rows when tool interaction state changes", () => {
    const tool: DisplayToolCall = {
      id: "execute",
      name: "bash",
      args: { command: "printf 'one\\ntwo\\n'", description: "print lines" },
      result: "one\ntwo",
      status: "completed",
    };
    const messages: readonly DisplayMessage[] = [{
      key: "a",
      role: "assistant",
      content: "",
      toolCalls: [tool],
    }];
    const interaction = new TraceInteractionState();
    const component = new ResponsiveTranscriptComponent(() => ({
      messages,
      options: { traceInteraction: interaction },
    }));

    expect(component.render(80).join("\n")).not.toContain("one");
    const group = buildTraceGroups([tool])[0]!;
    const groupKey = interaction.groupKey(group);
    interaction.activate({ kind: "group", key: groupKey, groupKey, foldable: true }, 2);
    expect(component.render(80).join("\n")).toContain("one");
  });

  it("dispatches a subagent inspector action on transcript double-click", () => {
    const interaction = new TraceInteractionState();
    const onTraceAction = vi.fn();
    const messages: readonly DisplayMessage[] = [{
      key: "subagent",
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "spawn",
        name: "spawn_agent",
        args: {},
        result: "done",
        status: "completed",
        metadata: {
          kind: "subagent",
          subagents: [{ subAgentId: "child-1", nickname: "Karen", status: "completed" }],
        },
      }],
    }];
    const component = new ResponsiveTranscriptComponent(
      () => ({ messages, options: { traceInteraction: interaction } }),
      { onTraceAction },
    );
    const rows = component.render(80);
    const row = rows.findIndex((line) => line.includes("Subagent"));

    expect(row).toBeGreaterThanOrEqual(0);
    component.handleMouse({ kind: "press", button: 0, release: false, clickCount: 2, x: 4, y: row } as never);
    expect(onTraceAction).toHaveBeenCalledWith({ kind: "open-subagent", subAgentId: "child-1" });
  });

  it("renders sent images as interactive chips and opens them on click", () => {
    const interaction = new TraceInteractionState();
    const onTraceAction = vi.fn();
    const messages: readonly DisplayMessage[] = [{
      key: "user-image",
      role: "user",
      content: "[Image #1] inspect this",
      images: [{
        label: "[Image #1]",
        base64: "YQ==",
        mediaType: "image/png",
        bytes: 1,
        dataUrl: "data:image/png;base64,YQ==",
      }],
    }];
    const component = new ResponsiveTranscriptComponent(
      () => ({ messages, options: { traceInteraction: interaction } }),
      { onTraceAction },
    );
    const rows = component.render(80);
    const row = rows.findIndex((line) => line.includes("[Image #1]"));

    expect(row).toBeGreaterThanOrEqual(0);
    expect(rows[row]).toContain("[Image #1] inspect this");
    expect(rows.join("\n")).not.toContain("└ [Image #1]");
    expect(rows.join("\n")).not.toContain("▣");
    component.handleMouse({ kind: "move", button: 35, release: false, clickCount: 1, x: 8, y: row } as never);
    component.handleMouse({ kind: "press", button: 0, release: false, clickCount: 1, x: 8, y: row } as never);
    expect(onTraceAction).toHaveBeenCalledWith({
      kind: "open-image",
      messageKey: "user-image",
      imageLabel: "[Image #1]",
    });
  });

  it("reconstructs a persisted session summary as an inspectable Compact entry", () => {
    const messages = reconstructDisplayMessages([
      { role: "system", content: "Bubble system prompt" },
      { role: "system", content: "Previous conversation summary: Goal: preserve auth" },
      { role: "user", content: "continue" },
    ]);

    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "Compaction completed.",
      syntheticKind: "ui_compact_summary",
      compactionSummary: "Goal: preserve auth",
    });
    expect(messages[1]).toMatchObject({ role: "user", content: "continue" });
  });

  it("reconstructs persisted multimedia user turns with stable image labels", () => {
    const messages = reconstructDisplayMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "first image" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "two more" },
          { type: "image_url", image_url: { url: "data:image/png;base64,Yg==" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,Yw==" } },
        ],
      },
    ]);

    expect(messages[0]?.content).toContain("[Image #1]");
    expect(messages[0]?.images?.[0]).toMatchObject({
      label: "[Image #1]",
      mediaType: "image/png",
      bytes: 1,
    });
    expect(messages[0]?.content).not.toContain("(multimedia)");
    expect(messages[1]?.content).toContain("└ [Image #2]\n└ [Image #3]");
  });

  it("restores the exact inline chip position from persisted user UI metadata", () => {
    const messages = reconstructDisplayMessages([{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
        { type: "text", text: "这在干嘛" },
      ],
      ui: { displayText: "[Image #4] 这在干嘛", imageDisplayStart: 4 },
    }]);

    expect(messages[0]).toMatchObject({
      content: "[Image #4] 这在干嘛",
      images: [{ label: "[Image #4]" }],
    });
  });
});
