import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { MessageList } from "../tui-ink/message-list.js";
import type { DisplayMessage, DisplayToolCall } from "../tui-ink/display-history.js";

const terminalColumns = 100;

function render(toolCall: DisplayToolCall, verboseTrace = false): string {
  const messages: DisplayMessage[] = [{
    key: "assistant-tools",
    role: "assistant",
    content: "",
    parts: [{ type: "tools", toolCalls: [toolCall] }],
  }];
  return renderToString(
    React.createElement(MessageList, {
      messages,
      streamingContent: "",
      streamingReasoning: "",
      streamingTools: [],
      streamingParts: [],
      terminalColumns,
      verboseTrace,
    }),
    { columns: terminalColumns },
  );
}

const MULTILINE_COMMAND = 'cd "/some/long/path" && echo "═══ tun ═══"; grep -n -A8 "^tun:" config.yaml; echo done';
const LONG_OUTPUT = Array.from({ length: 16 }, (_, i) => `output line ${i + 1}`).join("\n");

describe("collapsed Execute trace rows", () => {
  it("collapses a finished command to title + output count", () => {
    const output = render({
      id: "bash-1",
      name: "bash",
      args: { command: MULTILINE_COMMAND, description: "确认 TUN 配置" },
      result: LONG_OUTPUT,
    });

    expect(output).toContain("Execute");
    expect(output).toContain("确认 TUN 配置");
    expect(output).toContain("output · Ctrl+O to view");
    // The command body and stdout preview stay hidden.
    expect(output).not.toContain("grep -n -A8");
    expect(output).not.toContain("output line 1");
  });

  it("inlines a truncated command when there is no description", () => {
    const output = render({
      id: "bash-2",
      name: "bash",
      args: { command: MULTILINE_COMMAND },
      result: "ok",
    });

    expect(output).toContain('cd "/some/long/path"');
    expect(output).not.toContain("echo done");
  });

  it("keeps failures fully expanded", () => {
    const output = render({
      id: "bash-3",
      name: "bash",
      args: { command: "npm test" },
      result: "Error: 3 tests failed\nexpected 1 to be 2",
      isError: true,
    });

    expect(output).toContain("npm test");
    expect(output).toContain("3 tests failed");
    expect(output).not.toContain("Ctrl+O to view");
  });

  it("keeps running commands visible", () => {
    const output = render({
      id: "bash-4",
      name: "bash",
      args: { command: "npm run build" },
      startedAt: 1000,
    });

    expect(output).toContain("npm run build");
    expect(output).not.toContain("output · Ctrl+O to view");
  });
});
