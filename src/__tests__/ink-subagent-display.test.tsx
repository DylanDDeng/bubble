import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage } from "../tui-ink/display-history.js";

describe("Ink subagent display", () => {
  const subagentTool = {
    id: "spawn_1",
    name: "spawn_agent",
    args: { message: "review this" },
    result: "Running Ada (explorer)...",
    metadata: {
      kind: "subagent" as const,
      subagents: [{
        subAgentId: "child_1",
        agentName: "explorer",
        nickname: "Ada",
        category: "review",
        status: "running",
        task: "review this",
        toolNotes: ["grep: 3 matches"],
      }],
    },
  };

  function render(verboseTrace: boolean): string {
    const messages: DisplayMessage[] = [{
      role: "assistant",
      content: "",
      toolCalls: [subagentTool],
    }];
    return renderToString(
      React.createElement(MessageList, {
        messages,
        streamingContent: "",
        streamingReasoning: "",
        streamingTools: [],
        streamingParts: [],
        terminalColumns: 100,
        verboseTrace,
      }),
      { columns: 100 },
    );
  }

  it("shows subagent category and status in expanded Ink trace mode", () => {
    const output = render(true);

    expect(output).toContain("Subagents");
    expect(output).toContain("explorer/review");
    expect(output).toContain("running");
    expect(output).toContain("grep: 3 matches");
  });

  it("keeps subagent category and status visible in collapsed Ink trace mode", () => {
    const output = render(false);

    expect(output).toContain("Subagents");
    expect(output).toContain("Ada (explorer/review) running grep: 3 matches");
  });
});
