import test from "node:test";
import assert from "node:assert/strict";
import {
  appendEvent,
  historyRows,
  finishRows,
  snapshotRows,
} from "../src/timeline.mjs";
import {
  conversationTurns,
  stageEntries,
  stageSummary,
  toolPresentation,
  formatElapsed,
} from "../src/worktrace.mjs";
const tool = (id, name, args, status = "done") => ({
  kind: "tool",
  id,
  name,
  input: JSON.stringify(args),
  status,
});
test("command summary uses description and retains the exact command for details", () => {
  const row = tool("1", "bash", {
    command: "curl --fail --silent https://example.com/release.json",
    description: "核对线上版本",
  });
  const info = toolPresentation(row);
  assert.equal(info.target, "核对线上版本");
  assert.equal(
    info.command,
    "curl --fail --silent https://example.com/release.json",
  );
  assert.equal(
    stageSummary(stageEntries([row])[0]).label,
    "已执行 核对线上版本",
  );
  assert.equal(
    toolPresentation(tool("2", "bash", { command: "pwd" })).target,
    "pwd",
  );
});
test("adjacent exploration groups but narration and other tool categories preserve order", () => {
  const rows = [
    tool("r", "read", { path: "/src/a.ts" }),
    tool("g", "grep", { pattern: "manifest" }),
    { kind: "assistant", id: "note", text: "接下来验证部署" },
    tool("b", "bash", { command: "npm test" }),
    tool("b2", "bash", { command: "npm run build" }),
    tool("w", "task_output", { task_ids: ["t1"] }),
  ];
  const stages = stageEntries(rows);
  assert.deepEqual(
    stages.map((s) => s.kind),
    ["explore", "assistant", "command", "wait"],
  );
  assert.equal(stageSummary(stages[0]).label, "已探索 1 个文件、1 次搜索");
  assert.equal(stageSummary(stages[2]).label, "已执行 2 条命令");
  assert.equal(toolPresentation(rows.at(-1)).target, "1 个后台任务的结果");
});
test("latest active command owns the group label; failures remain visible", () => {
  const summary = stageSummary(
    stageEntries([
      tool("a", "bash", { command: "first" }, "error"),
      tool(
        "b",
        "bash",
        { command: "next", description: "检查正式域名" },
        "running",
      ),
    ])[0],
  );
  assert.equal(summary.label, "正在执行 检查正式域名");
  assert.equal(summary.state, "running");
  assert.equal(summary.errors, 1);
});
test("separate provider steps cannot merge adjacent assistant text", () => {
  let rows = appendEvent([], { type: "text_delta", content: "Commentary" });
  rows = appendEvent(rows, { type: "turn_start" });
  rows = appendEvent(rows, { type: "text_delta", content: "Final" });
  assert.deepEqual(
    rows.filter((r) => r.kind === "assistant").map((r) => r.text),
    ["Commentary", "Final"],
  );
});
test("completed trace hides work while keeping final answer outside and every previous turn independent", () => {
  const rows = historyRows([
    { role: "user", content: "First" },
    {
      role: "assistant",
      content: "Checking",
      toolCalls: [{ id: "1", name: "read", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "1", content: "ok" },
    { role: "assistant", content: "The answer" },
    { role: "user", content: "Second" },
  ]);
  const turns = conversationTurns(rows, true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].live, false);
  assert.equal(turns[0].final.text, "The answer");
  assert.equal(turns[0].work.length, 2);
  assert.equal(turns[1].live, true);
});
test("thought-only turn remains expandable, final-only response does not create empty work", () => {
  const thinking = conversationTurns(
    [
      { kind: "user", text: "Hi" },
      { kind: "reasoning", id: "r", text: "Thinking" },
    ],
    true,
  )[0];
  assert.equal(thinking.work[0].kind, "reasoning");
  assert.equal(thinking.final, null);
  const final = conversationTurns([
    { kind: "user", text: "Hi" },
    { kind: "assistant", text: "Hello" },
  ])[0];
  assert.equal(final.work.length, 0);
  assert.equal(final.final.text, "Hello");
});
test("stop interrupts unfinished tools, never retroactively marks them successful", () => {
  const original = [
    { kind: "user", text: "Hi" },
    tool("done", "read", {}, "done"),
    tool("running", "bash", {}, "running"),
  ];
  const rows = finishRows(original, {
    outcome: "cancelled",
    startedAt: 1000,
    endedAt: 5000,
  });
  assert.equal(rows[1].status, "done");
  assert.equal(rows[2].status, "interrupted");
  assert.equal(original[2].status, "running");
  assert.equal(conversationTurns(rows)[0].interrupted, true);
});
test("persisted calls without results stay interrupted; unknown tool results remain expandable", () => {
  const rows = historyRows([
    {
      role: "assistant",
      toolCalls: [
        { id: "a", name: "mcp_custom", arguments: '{"x":1}' },
        { id: "b", name: "bash", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "a", content: "Success detail" },
  ]);
  assert.equal(rows[0].output, "Success detail");
  assert.equal(rows[0].status, "done");
  assert.equal(rows[1].status, "interrupted");
  assert.equal(stageEntries(rows)[0].kind, "other");
});
test("reused tool ids in later turns do not alter previous tools", () => {
  let rows = [
    { kind: "user", text: "1" },
    tool("id", "bash", { command: "first" }),
    { kind: "user", text: "2" },
  ];
  rows = appendEvent(rows, {
    type: "tool_start",
    id: "id",
    name: "bash",
    args: { command: "second" },
  });
  assert.equal(rows[1].status, "done");
  assert.equal(rows[3].status, "running");
});
test("snapshot replay retains measured metadata and does not invent historical duration", () => {
  const snapshot = {
    history: [
      { role: "user", content: "Old" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "New" },
    ],
    events: [],
    turns: [
      { userIndex: 0, startedAt: 1000, endedAt: 46000, outcome: "completed" },
    ],
    turn: { startedAt: 50000, outcome: "running" },
  };
  const rows = snapshotRows(snapshot);
  assert.equal(rows[0].endedAt, 46000);
  assert.equal(rows[2].startedAt, 50000);
  assert.equal(formatElapsed(45000), "45 秒");
  assert.equal(formatElapsed(undefined), "");
});
test("invalid or partial JSON tool arguments cannot break the trace", () => {
  assert.equal(
    toolPresentation({ name: "bash", input: "{bad" }).kind,
    "command",
  );
  assert.equal(
    toolPresentation({ name: "task_output", input: '{"task_ids":42}' }).target,
    "后台任务结果",
  );
});
test("explicit cancellation and timeout result statuses are not shown as success", () => {
  let rows = appendEvent([], {
    type: "tool_start",
    id: "a",
    name: "bash",
    args: {},
  });
  rows = appendEvent(rows, {
    type: "tool_end",
    id: "a",
    name: "bash",
    result: { status: "cancelled", content: "Cancelled" },
  });
  assert.equal(rows[0].status, "interrupted");
  rows = appendEvent(rows, {
    type: "tool_end",
    id: "a",
    name: "bash",
    result: { status: "timeout", content: "Timed out" },
  });
  assert.equal(rows[0].status, "error");
});
