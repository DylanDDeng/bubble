import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Transcript } from "../src/components/WorkingTrace";
import { historyRows, appendEvent, finishRows } from "../src/timeline.mjs";
import type { Row } from "../src/types";
import "../src/styles.css";
const start = Date.now() - 45000;
const seed = [
  { role: "user", content: "确认网站是否上线" },
  {
    role: "assistant",
    content: "我会先检查构建和发布状态，再核对正式域名上的版本。",
    toolCalls: [
      {
        id: "read1",
        name: "read",
        arguments: JSON.stringify({
          path: "/workspace/scripts/verify-preview.mjs",
        }),
      },
      {
        id: "search1",
        name: "grep",
        arguments: JSON.stringify({
          pattern: "manifest|code_sha|release.json",
          path: "/workspace/scripts",
        }),
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "read1",
    content:
      "export async function verifyPreview() { /* validate release manifest */ }",
  },
  {
    role: "tool",
    toolCallId: "search1",
    content:
      "scripts/verify-preview.mjs:42: release.json\nscripts/release.mjs:18: code_sha",
  },
  {
    role: "assistant",
    reasoning: "需要区分构建成功和正式环境已经更新。",
    content:
      "合并后的构建和测试已通过，正式发布流程还在运行。我会等待发布结果，再检查正式域名上的版本号。",
    toolCalls: [
      {
        id: "cmd1",
        name: "bash",
        arguments: JSON.stringify({
          command: "gh run watch 35409511364 --exit-status --interval 10",
          description: "等待生产发布完成",
        }),
      },
      {
        id: "wait1",
        name: "task_output",
        arguments: JSON.stringify({
          task_ids: ["task_0011"],
          wait_ms: 20000,
          mode: "all",
        }),
      },
      {
        id: "cmd2",
        name: "bash",
        arguments: JSON.stringify({
          command:
            "curl --fail --silent --show-error --max-time 30 https://example.com/release.json",
          description: "核对线上版本",
        }),
      },
      {
        id: "cmd3",
        name: "bash",
        arguments: JSON.stringify({
          command:
            "curl --fail --silent --show-error --max-time 30 https://example.com/benchmarks",
          description: "检查正式站点评测页面",
        }),
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "cmd1",
    content: "✓ Production release completed\nExit code: 0",
  },
  { role: "tool", toolCallId: "wait1", content: "task_0011 completed" },
  {
    role: "tool",
    toolCallId: "cmd2",
    content: '{"version":"0.0.58","code_sha":"bf11c76"}',
  },
  {
    role: "tool",
    toolCallId: "cmd3",
    content: "HTTP/2 200\nBenchmark page is available.",
  },
  {
    role: "assistant",
    content:
      "**已经上线。**\n\n- 生产发布任务已完成。\n- 正式站点版本与本次合并一致。\n- 新增评测页面访问正常。",
  },
];
function Fixture() {
  const [rows, setRows] = useState<Row[]>(() => {
    const r = historyRows(seed);
    r[0] = {
      ...r[0],
      startedAt: start,
      endedAt: start + 45000,
      outcome: "completed",
    };
    return r;
  });
  const [active, setActive] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [session, setSession] = useState("fixture");
  const [dark, setDark] = useState(false);
  function running() {
    const r = historyRows([
      ...seed.slice(0, 4),
      {
        role: "assistant",
        reasoning: "需要区分构建成功和正式环境已经更新。",
        content: "合并后的构建和测试已通过，正在等待生产发布完成。",
      },
    ]);
    r[0] = { ...r[0], startedAt: Date.now(), outcome: "running" };
    r.push({
      kind: "tool",
      id: "live1",
      name: "bash",
      input: JSON.stringify({
        command: "gh run watch 35409511364 --exit-status",
        description: "等待生产发布完成",
      }),
      status: "running",
      startedAt: Date.now(),
    });
    setRows(r);
    setActive(true);
    setWaiting(false);
    setChoices({});
  }
  return (
    <div
      style={{
        minHeight: "100vh",
        maxWidth: 1060,
        margin: "0 auto",
        padding: "32px 40px",
      }}
    >
      <div
        style={{
          borderBottom: "1px solid var(--line)",
          paddingBottom: 20,
          marginBottom: 35,
        }}
      >
        <strong>Working trace · 交互验收</strong>
        <p className="muted">
          固定测试数据，使用正式会话组件，不连接模型、不执行命令。
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="soft-button"
            onClick={() => {
              const r = historyRows(seed);
              r[0] = { ...r[0], startedAt: start, endedAt: start + 45000 };
              setRows(r);
              setActive(false);
              setWaiting(false);
              setChoices({});
            }}
          >
            已完成场景
          </button>
          <button className="soft-button" onClick={running}>
            开始运行
          </button>
          <button
            className="soft-button"
            onClick={() =>
              setRows((old) =>
                appendEvent(
                  appendEvent(old, {
                    type: "tool_end",
                    id: "live1",
                    name: "bash",
                    result: { content: "Release succeeded." },
                    at: Date.now(),
                  }),
                  {
                    type: "tool_start",
                    id: "live2",
                    name: "bash",
                    args: {
                      command: "curl https://example.com/release.json",
                      description: "核对线上版本",
                    },
                    at: Date.now(),
                  },
                ),
              )
            }
          >
            推进一步
          </button>
          <button
            className="soft-button"
            onClick={() => {
              setRows((old) =>
                finishRows(old, { outcome: "cancelled", endedAt: Date.now() }),
              );
              setActive(false);
              setWaiting(false);
            }}
          >
            停止任务
          </button>
          <button
            className="soft-button"
            onClick={() => {
              setRows((old) =>
                finishRows(
                  appendEvent(old, {
                    type: "tool_end",
                    id: "live2",
                    name: "bash",
                    result: {
                      content:
                        "curl: (28) Operation timed out after 30000 milliseconds",
                      isError: true,
                    },
                    at: Date.now(),
                  }),
                  { outcome: "failed", endedAt: Date.now() },
                ),
              );
              setActive(false);
              setWaiting(false);
            }}
          >
            模拟失败
          </button>
          <button className="soft-button" onClick={() => setWaiting((v) => !v)}>
            切换等待审批
          </button>
          <button
            className="soft-button"
            onClick={() => {
              setDark(!dark);
              document.documentElement.dataset.theme = dark ? "light" : "dark";
            }}
          >
            切换主题
          </button>
          <button
            className="soft-button"
            onClick={() =>
              setSession((s) => (s === "fixture" ? "other-session" : "fixture"))
            }
          >
            切换会话
          </button>
        </div>
      </div>
      <Transcript
        rows={rows}
        active={active}
        waiting={waiting}
        sessionKey={session}
        choices={choices}
        onChoice={(key, value) =>
          setChoices((old) => ({ ...old, [key]: value }))
        }
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
