import { createContext, useContext, useEffect, useState } from "react";
import {
  ChevronRight,
  Terminal,
  FolderSearch,
  FilePenLine,
  Globe,
  Layers,
  Brain,
  Plug,
  Clock3,
  CircleAlert,
  CircleDashed,
} from "lucide-react";
import type { Row } from "../types";
import {
  conversationTurns,
  stageEntries,
  stageSummary,
  toolInput,
  toolPresentation,
  formatElapsed,
} from "../worktrace.mjs";
import { Markdown } from "./Markdown";
import "./working-trace.css";

type Disclosure = {
  prefix: string;
  choices: Record<string, boolean>;
  onChoice: (key: string, open: boolean) => void;
};
const DisclosureContext = createContext<Disclosure>({
  prefix: "",
  choices: {},
  onChoice: () => {},
});
function useDisclosure(id: string, fallback = false) {
  const context = useContext(DisclosureContext);
  const key = `${context.prefix}:${id}`;
  return [
    context.choices[key] ?? fallback,
    (open: boolean) => context.onChoice(key, open),
  ] as const;
}
function ToggleChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight className={`trace-chevron ${open ? "open" : ""}`} size={13} />
  );
}
function StageIcon({ kind, state }: { kind: string; state?: string }) {
  const Icon =
    state === "error"
      ? CircleAlert
      : state === "interrupted"
        ? CircleDashed
        : {
            explore: FolderSearch,
            command: Terminal,
            edit: FilePenLine,
            wait: Clock3,
            agent: Layers,
            memory: Brain,
            web: Globe,
          }[kind] || Plug;
  return <Icon size={14} className="trace-kind-icon" />;
}
function statusLabel(status?: string) {
  return status === "error"
    ? "失败"
    : status === "interrupted"
      ? "已中断"
      : status === "running"
        ? "运行中"
        : "已完成";
}
function ToolDetails({
  row,
  waiting = false,
}: {
  row: Row;
  waiting?: boolean;
}) {
  const info = toolPresentation(row);
  const [raw, setRaw] = useDisclosure(`raw:${row.id}`);
  const args = toolInput(row);
  const duration =
    row.startedAt !== undefined && row.endedAt !== undefined
      ? formatElapsed(row.endedAt - row.startedAt)
      : "";
  return (
    <div className="trace-tool-detail">
      <div className="trace-detail-meta">
        <span>{row.name}</span>
        <span>
          {waiting && row.status === "running"
            ? "等待回应"
            : statusLabel(row.status)}
          {duration && ` · ${duration}`}
        </span>
      </div>
      {info.command && (
        <pre className="trace-command">
          <span aria-hidden="true">$ </span>
          {info.command}
        </pre>
      )}
      {info.path && <div className="trace-path">{info.path}</div>}
      {info.query && <div className="trace-query">{info.query}</div>}
      {row.update && (
        <div className="trace-update">
          {typeof row.update.summary === "string"
            ? row.update.summary
            : typeof row.update.description === "string"
              ? row.update.description
              : "子任务进度已更新"}
        </div>
      )}
      <div className={`trace-output ${row.status === "error" ? "error" : ""}`}>
        <div className="trace-output-label">输出</div>
        {row.output ? (
          <pre>{row.output}</pre>
        ) : (
          <p>
            {row.status === "running"
              ? waiting
                ? "等待你的回应后继续。"
                : "等待工具返回…"
              : row.status === "interrupted"
                ? "执行已中断，没有完整结果。"
                : "无输出"}
          </p>
        )}
      </div>
      <button
        className="trace-raw-toggle"
        aria-expanded={raw}
        onClick={() => setRaw(!raw)}
      >
        输入参数
        <ToggleChevron open={raw} />
      </button>
      {raw && (
        <pre className="trace-raw">
          {Object.keys(args).length
            ? JSON.stringify(args, null, 2)
            : row.input || "无参数"}
        </pre>
      )}
    </div>
  );
}
function ToolEntry({ row, waiting }: { row: Row; waiting: boolean }) {
  const info = toolPresentation(row);
  const [open, setOpen] = useDisclosure(`tool:${row.id}`);
  return (
    <div className={`trace-tool-entry ${row.status}`}>
      <button
        className="trace-entry-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="trace-entry-action">{info.action}</span>
        <span className="trace-entry-target" title={info.path || info.target}>
          {info.target}
        </span>
        {["error", "interrupted"].includes(row.status || "") && (
          <span className="trace-status-text">{statusLabel(row.status)}</span>
        )}
        <ToggleChevron open={open} />
      </button>
      {open && <ToolDetails row={row} waiting={waiting} />}
    </div>
  );
}
function Stage({
  stage,
  waiting,
}: {
  stage: ReturnType<typeof stageEntries>[number];
  waiting: boolean;
}) {
  const summary = stageSummary(stage);
  if (waiting && summary.state === "running") {
    summary.state = "waiting";
    summary.label = `等待确认 · ${toolPresentation(stage.rows.find((row) => row.status === "running")!).target}`;
  }
  const [open, setOpen] = useDisclosure(
    `stage:${stage.id}`,
    summary.state === "running" ||
      summary.state === "waiting" ||
      summary.state === "error",
  );
  return (
    <section className={`trace-stage ${summary.state}`}>
      <button
        className="trace-stage-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <StageIcon kind={stage.kind} state={summary.state} />
        <span
          className={`trace-stage-label ${summary.state === "running" ? "trace-active-label" : ""}`}
          title={summary.label}
        >
          {summary.label}
        </span>
        {summary.errors > 0 && (
          <span className="trace-failure-count">{summary.errors} 项失败</span>
        )}
        <ToggleChevron open={open} />
      </button>
      {open && (
        <div className="trace-stage-body">
          {stage.rows.length === 1 ? (
            <ToolDetails row={stage.rows[0]} waiting={waiting} />
          ) : (
            stage.rows.map((row) => (
              <ToolEntry key={row.id} row={row} waiting={waiting} />
            ))
          )}
        </div>
      )}
    </section>
  );
}
function Reasoning({ row, live }: { row: Row; live: boolean }) {
  const [open, setOpen] = useDisclosure(`reasoning:${row.id}`);
  return (
    <section className="trace-reasoning">
      <button
        className="trace-reasoning-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={live ? "trace-active-label" : ""}>
          {live ? "正在思考" : "思考过程"}
        </span>
        <ToggleChevron open={open} />
      </button>
      {open && (
        <div className="trace-reasoning-content">
          <Markdown text={row.text || ""} />
        </div>
      )}
    </section>
  );
}
function WorkBody({
  rows,
  live,
  waiting,
}: {
  rows: Row[];
  live: boolean;
  waiting: boolean;
}) {
  return (
    <div className="trace-body">
      {stageEntries(rows).map((stage) =>
        stage.kind === "assistant" ? (
          <div className="trace-narration" key={stage.id}>
            <Markdown text={stage.rows[0].text || ""} />
          </div>
        ) : stage.kind === "reasoning" ? (
          <Reasoning
            key={stage.id}
            row={stage.rows[0]}
            live={live && rows.at(-1) === stage.rows[0]}
          />
        ) : stage.rows[0].kind === "tool" ? (
          <Stage key={stage.id} stage={stage} waiting={waiting} />
        ) : (
          <div key={stage.id} className={`trace-notice ${stage.kind}`}>
            {stage.rows[0].text}
          </div>
        ),
      )}
    </div>
  );
}
function WorkTurn({
  turn,
  waiting,
}: {
  turn: ReturnType<typeof conversationTurns>[number];
  waiting: boolean;
}) {
  const [open, setOpen] = useDisclosure(
    `work:${turn.id}`,
    turn.live || turn.failed || turn.interrupted || turn.failedCount > 0,
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!turn.live || !turn.startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn.live, turn.startedAt]);
  const duration =
    turn.startedAt !== undefined
      ? formatElapsed((turn.endedAt ?? now) - turn.startedAt)
      : "";
  const activeTool = [...turn.work]
    .reverse()
    .find((row: Row) => row.kind === "tool" && row.status === "running");
  const activeStage = activeTool
    ? stageSummary({
        kind: toolPresentation(activeTool).kind,
        rows: [activeTool],
      }).label
    : "";
  const label = turn.live
    ? waiting
      ? "等待你的回应"
      : !open && activeStage
        ? activeStage
        : "正在工作"
    : turn.failed
      ? "本轮未完成"
      : turn.interrupted
        ? "已停止"
        : "已完成";
  const hasWork = turn.work.length > 0;
  return (
    <section className="conversation-turn" data-turn={turn.id}>
      {turn.user && <div className="user-message">{turn.user.text}</div>}
      {(hasWork || turn.live || turn.failed || turn.interrupted) && (
        <div className={`worktrace ${turn.live ? "live" : "complete"}`}>
          <div className="trace-header">
            <button
              className="trace-toggle"
              aria-expanded={hasWork ? open : undefined}
              disabled={!hasWork}
              onClick={() => setOpen(!open)}
            >
              {turn.live && <span className="trace-live-dot" />}
              <span
                className={turn.live && !waiting ? "trace-active-label" : ""}
              >
                {label}
              </span>
              {duration && <span className="trace-duration">· {duration}</span>}
              {!duration && !turn.live && turn.toolCount > 0 && (
                <span className="trace-duration">
                  · {turn.toolCount} 项操作
                </span>
              )}
              {turn.failedCount > 0 && (
                <span className="trace-failure-count">
                  {turn.failedCount} 项失败
                </span>
              )}
              {hasWork && <ToggleChevron open={open} />}
            </button>
          </div>
          {open && hasWork && (
            <WorkBody rows={turn.work} live={turn.live} waiting={waiting} />
          )}
        </div>
      )}
      {turn.final && (
        <article className="assistant-message">
          <Markdown text={turn.final.text || ""} />
        </article>
      )}
    </section>
  );
}
export function Transcript({
  rows,
  active,
  waiting,
  sessionKey,
  choices,
  onChoice,
}: {
  rows: Row[];
  active: boolean;
  waiting: boolean;
  sessionKey: string;
  choices: Record<string, boolean>;
  onChoice: Disclosure["onChoice"];
}) {
  return (
    <>
      {conversationTurns(rows, active).map((turn) => (
        <DisclosureContext.Provider
          key={`${sessionKey}:${turn.id}`}
          value={{ prefix: `${sessionKey}:${turn.id}`, choices, onChoice }}
        >
          <WorkTurn turn={turn} waiting={turn.live && waiting} />
        </DisclosureContext.Provider>
      ))}
    </>
  );
}
