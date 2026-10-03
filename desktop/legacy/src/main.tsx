import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  Square,
  Plus,
  Search,
  PanelLeft,
  Folder,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Settings,
  X,
  Check,
  FileCode2,
  Sparkles,
  MessageSquare,
  Sun,
  Moon,
  Monitor,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { Markdown } from "./components/Markdown";
import { Transcript } from "./components/WorkingTrace";
import { appendEvent, snapshotRows, finishRows } from "./timeline.mjs";
import type {
  Bootstrap,
  Session,
  Model,
  View,
  Interaction,
  Preferences,
} from "./types";
import "./styles.css";
const api = window.bubble;
const emptyView = (): View => ({ rows: [], active: false, interactions: [] });
const basename = (p = "") => p.split("/").filter(Boolean).at(-1) || p;
const shortTime = (time: number) => {
  const days = Math.floor((Date.now() - time) / 86400000);
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
};
function BubbleMark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "bubble-mark small" : "bubble-mark"}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M11 19 9 7l12 7a25 25 0 0 1 7 0L40 7l-2 13c4 4 5 8 2 13-3 5-9 8-16 8S10 38 7 33c-3-5-1-10 4-14Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinejoin="round"
      />
      <path
        d="M16 25v3m16-3v3m-11 5 3 2 3-2"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
function InteractionCard({
  item,
  onReply,
}: {
  item: Interaction;
  onReply: (id: string, value: unknown) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<string[][]>(
    (item.payload.questions ?? []).map(() => []),
  );
  const [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function reply(value: unknown) {
    setBusy(true);
    try {
      await onReply(item.id, value);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="interaction">
      <div className="interaction-title">
        <ShieldCheck size={17} />
        {item.kind === "approval"
          ? "需要你的批准"
          : item.kind === "plan"
            ? "确认执行计划"
            : "需要你的回答"}
      </div>
      {item.kind === "approval" && (
        <>
          <p>
            {item.payload.command
              ? "Bubble 希望执行以下命令"
              : `Bubble 希望使用 ${item.payload.type}`}
          </p>
          <pre>
            {item.payload.command ||
              item.payload.diff ||
              item.payload.content ||
              item.payload.promptPreview ||
              JSON.stringify(item.payload, null, 2)}
          </pre>
          {item.payload.path && (
            <div className="muted">{item.payload.path}</div>
          )}
        </>
      )}
      {item.kind === "plan" && <Markdown text={item.payload} />}
      {item.kind === "question" &&
        item.payload.questions.map((q: any, i: number) => (
          <fieldset key={i}>
            <legend>{q.question}</legend>
            {q.options.map((o: any) => (
              <label className="answer" key={o.label}>
                <input
                  type={q.multiple ? "checkbox" : "radio"}
                  name={`${item.id}-${i}`}
                  checked={answers[i]?.includes(o.label) || false}
                  onChange={() =>
                    setAnswers((old) =>
                      old.map((a, j) =>
                        j !== i
                          ? a
                          : q.multiple
                            ? a.includes(o.label)
                              ? a.filter((v) => v !== o.label)
                              : [...a, o.label]
                            : [o.label],
                      ),
                    )
                  }
                />
                <span>
                  {o.label}
                  <small>{o.description}</small>
                </span>
              </label>
            ))}
            {q.custom !== false && (
              <input
                className="text-input"
                aria-label={`自定义回答 ${i + 1}`}
                placeholder="也可以输入自己的回答"
                value={custom[i] || ""}
                onChange={(e) =>
                  setCustom((old) => {
                    const next = [...old];
                    next[i] = e.target.value;
                    return next;
                  })
                }
              />
            )}
          </fieldset>
        ))}
      <div className="interaction-actions">
        <button
          className="soft-button"
          disabled={busy}
          onClick={() =>
            void reply(
              item.kind === "approval"
                ? { action: "reject" }
                : item.kind === "plan"
                  ? false
                  : null,
            )
          }
        >
          拒绝 / 跳过
        </button>
        <button
          className="primary-button"
          disabled={
            busy ||
            (item.kind === "question" &&
              answers.some((a, i) => !a.length && !custom[i]?.trim()))
          }
          onClick={() =>
            void reply(
              item.kind === "approval"
                ? { action: "approve" }
                : item.kind === "plan"
                  ? true
                  : answers.map((a, i) =>
                      custom[i]?.trim() ? [...a, custom[i].trim()] : a,
                    ),
            )
          }
        >
          {item.kind === "question" ? "提交回答" : "批准此次操作"}
        </button>
      </div>
    </div>
  );
}
function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [preferences, setPreferences] = useState<Preferences>({
    projects: [],
    theme: "system",
    home: "",
    version: "",
  });
  const [views, setViews] = useState<Record<string, View>>({});
  const [traceChoices, setTraceChoices] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [mode, setMode] = useState("default");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [settings, setSettings] = useState(false);
  const [picker, setPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const [hostFailed, setHostFailed] = useState(false);
  const [providers, setProviders] = useState<Bootstrap["config"]["providers"]>(
    [],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const selectedRef = useRef<string | null>(null);
  const newTaskRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const view = selected ? views[selected] || emptyView() : emptyView();
  const currentModel = models.find((m) => m.id === model);
  const selectedSession = sessions.find((s) => s.name === selected);
  const projectPaths = [
    ...new Set([
      ...preferences.projects,
      ...(sessions.map((s) => s.cwd).filter(Boolean) as string[]),
    ]),
  ];
  async function refreshSessions() {
    setSessions(await api.call<Session[]>("sessions"));
  }
  function handleError(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      handleError(e);
    }
  }
  function newTask() {
    setDrafts((old) => ({ ...old, [selectedRef.current || "new"]: prompt }));
    selectedRef.current = null;
    setSelected(null);
    setPrompt(drafts.new || "");
    setError("");
    setLoadingSession(false);
    follow.current = true;
    textarea.current?.focus();
  }
  newTaskRef.current = newTask;
  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      if (event.type === "settings") {
        setSettings(true);
        return;
      }
      if (event.type === "new_task") {
        newTaskRef.current();
        return;
      }
      if (event.type === "host_failure") {
        setHostFailed(true);
        setError(event.message);
        setViews((old) =>
          Object.fromEntries(
            Object.entries(old).map(([id, value]) => [
              id,
              {
                ...value,
                active: false,
                interactions: [],
                rows: finishRows(value.rows, {
                  outcome: "failed",
                  endedAt: Date.now(),
                }),
              },
            ]),
          ),
        );
        return;
      }
      const id = event.sessionId;
      if (!id) return;
      setViews((old) => {
        const value = old[id] || emptyView();
        if (event.type === "started")
          return {
            ...old,
            [id]: {
              ...emptyView(),
              rows: snapshotRows(event.snapshot),
              active: true,
            },
          };
        if (event.type === "agent")
          return {
            ...old,
            [id]: {
              ...value,
              rows: appendEvent(value.rows, event.event),
              ...(event.event.type === "turn_end" && event.event.usage
                ? {
                    usage: `${((event.event.usage.promptTokens || 0) + (event.event.usage.completionTokens || 0)).toLocaleString()} tokens`,
                  }
                : {}),
            },
          };
        if (event.type === "interaction")
          return {
            ...old,
            [id]: {
              ...value,
              interactions: [
                ...value.interactions.filter((p) => p.id !== event.id),
                event,
              ],
            },
          };
        if (event.type === "interaction_closed")
          return {
            ...old,
            [id]: {
              ...value,
              interactions: value.interactions.filter((p) => p.id !== event.id),
            },
          };
        if (event.type === "failure")
          return { ...old, [id]: { ...value, error: event.message } };
        if (event.type === "finished")
          return {
            ...old,
            [id]: {
              ...value,
              active: false,
              interactions: [],
              rows: finishRows(value.rows, event.turn),
            },
          };
        return old;
      });
      if (event.type === "finished" || event.type === "started")
        void refreshSessions().catch(handleError);
    });
    void Promise.all([
      api.call<Bootstrap>("bootstrap"),
      api.call<Preferences>("preferences"),
    ])
      .then(([data, prefs]) => {
        setSessions(data.sessions);
        setModels(data.models);
        setProviders(data.config.providers);
        setPreferences(prefs);
        setCwd(
          prefs.projects[0] ||
            data.sessions.find((s) => s.cwd)?.cwd ||
            prefs.home,
        );
        const chosen = data.config.defaultModel.includes(":")
          ? data.config.defaultModel
          : `${data.config.defaultProviderId}:${data.config.defaultModel}`;
        setModel(chosen !== ":" ? chosen : data.models[0]?.id || "");
      })
      .catch(handleError)
      .finally(() => setLoading(false));
    return unsubscribe;
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);
  useEffect(() => {
    setEffort(currentModel?.defaultReasoningLevel || "");
  }, [model]);
  useEffect(() => {
    if (follow.current)
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "instant",
      });
  }, [view.rows, view.interactions, selected]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 190)}px`;
    }
  }, [prompt]);
  async function selectSession(session: Session) {
    setDrafts((old) => ({ ...old, [selectedRef.current || "new"]: prompt }));
    selectedRef.current = session.name;
    setSelected(session.name);
    setCwd(session.cwd || preferences.home);
    setPrompt(drafts[session.name] || "");
    setError("");
    follow.current = true;
    if (views[session.name]) {
      setLoadingSession(false);
      return;
    }
    setLoadingSession(true);
    try {
      const snapshot = await api.call("snapshot", { sessionId: session.name });
      setViews((old) =>
        old[session.name]
          ? old
          : {
              ...old,
              [session.name]: {
                rows: snapshotRows(snapshot),
                active: snapshot.active,
                interactions: snapshot.interactions,
              },
            },
      );
    } finally {
      if (selectedRef.current === session.name) setLoadingSession(false);
    }
  }
  async function chooseProject() {
    const path = await api.call<string | null>("chooseProject");
    if (path) {
      setPreferences((old) => ({
        ...old,
        projects: [...new Set([...old.projects, path])],
      }));
      newTask();
      setCwd(path);
    }
  }
  async function send() {
    if (!prompt.trim() || view.active || sending || hostFailed) return;
    const text = prompt.trim();
    setSending(true);
    setError("");
    try {
      let id = selected;
      if (!id) {
        const ref = await api.call("create", { cwd });
        id = ref.id;
        selectedRef.current = id;
        setSelected(id);
      }
      await api.call("run", {
        sessionId: id,
        prompt: text,
        model,
        mode,
        thinkingLevel: effort,
      });
      setPrompt("");
      setDrafts((old) => ({ ...old, [id!]: "", new: "" }));
      follow.current = true;
    } catch (e) {
      handleError(e);
    } finally {
      setSending(false);
    }
  }
  const filteredSessions = sessions.filter(
    (s) =>
      !search ||
      `${s.title} ${s.preview} ${s.cwd}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <div className={`app ${sidebar ? "" : "sidebar-hidden"}`}>
      <aside className="sidebar">
        <div className="sidebar-titlebar">
          <button
            className="icon-button"
            aria-label="隐藏侧栏"
            onClick={() => setSidebar(false)}
          >
            <PanelLeft size={17} />
          </button>
        </div>
        <div className="sidebar-brand">
          <BubbleMark small />
          <strong>Bubble</strong>
          <span>桌面版</span>
        </div>
        <nav className="nav">
          <button
            className={!selected ? "nav-button active" : "nav-button"}
            onClick={newTask}
          >
            <Plus size={18} />
            <span>新建任务</span>
            <kbd>⌘ N</kbd>
          </button>
          <button
            className="nav-button"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search size={17} />
            <span>搜索任务</span>
          </button>
        </nav>
        {searchOpen && (
          <div className="sidebar-search">
            <Search size={14} />
            <input
              autoFocus
              placeholder="搜索任务…"
              aria-label="搜索任务"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="icon-button"
              aria-label="关闭搜索"
              onClick={() => {
                setSearchOpen(false);
                setSearch("");
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="section-label">
          <span>项目</span>
          <button
            className="icon-button"
            aria-label="添加项目"
            title="添加项目"
            onClick={() => void act(chooseProject)}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-scroll">
          {projectPaths.length === 0 && (
            <button
              className="add-project"
              onClick={() => void act(chooseProject)}
            >
              <FolderOpen size={16} />
              打开一个项目
            </button>
          )}
          {projectPaths.map((path) => {
            const items = filteredSessions.filter((s) => s.cwd === path);
            return (
              <div className="project" key={path}>
                <div className="project-header">
                  <button
                    className="project-toggle"
                    title={path}
                    onClick={() =>
                      setCollapsed((old) =>
                        old.includes(path)
                          ? old.filter((p) => p !== path)
                          : [...old, path],
                      )
                    }
                  >
                    {collapsed.includes(path) ? (
                      <ChevronRight size={12} />
                    ) : (
                      <ChevronDown size={12} />
                    )}
                    <Folder size={15} />
                    <span>{basename(path)}</span>
                  </button>
                  <button
                    className="icon-button project-add"
                    aria-label={`在 ${basename(path)} 新建任务`}
                    onClick={() => {
                      newTask();
                      setCwd(path);
                    }}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {!collapsed.includes(path) && (
                  <div className="project-tasks">
                    {items.length === 0 && (
                      <div className="no-tasks">
                        {search ? "没有匹配的任务" : "还没有任务"}
                      </div>
                    )}
                    {(search || expandedProjects.includes(path)
                      ? items
                      : items.slice(0, 8)
                    ).map((s) => (
                      <button
                        key={s.name}
                        className={`task-button ${selected === s.name ? "selected" : ""}`}
                        title={s.title || s.preview}
                        onClick={() => void act(() => selectSession(s))}
                      >
                        <span
                          className={`task-dot ${views[s.name]?.active || s.active ? "running" : ""}`}
                        />
                        <span>{s.title || s.preview || "新任务"}</span>
                        <time>{shortTime(s.mtime)}</time>
                      </button>
                    ))}
                    {!search && items.length > 8 && (
                      <button
                        className="show-more"
                        onClick={() =>
                          setExpandedProjects((old) =>
                            old.includes(path)
                              ? old.filter((p) => p !== path)
                              : [...old, path],
                          )
                        }
                      >
                        {expandedProjects.includes(path)
                          ? "收起"
                          : `查看另外 ${items.length - 8} 个任务`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {filteredSessions.filter((s) => !s.cwd).length > 0 && (
            <>
              <div className="section-label">其他任务</div>
              {filteredSessions
                .filter((s) => !s.cwd)
                .map((s) => (
                  <button
                    key={s.name}
                    className="task-button"
                    onClick={() => void act(() => selectSession(s))}
                  >
                    <MessageSquare size={14} />
                    <span>{s.title || "未命名任务"}</span>
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="sidebar-footer">
          <button className="nav-button" onClick={() => setSettings(true)}>
            <Settings size={17} />
            <span>设置</span>
            <kbd>⌘ ,</kbd>
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            {!sidebar && (
              <button
                className="icon-button show-sidebar"
                aria-label="显示侧栏"
                onClick={() => setSidebar(true)}
              >
                <PanelLeft size={17} />
              </button>
            )}
            <span>{basename(cwd) || "工作空间"}</span>
            <ChevronRight size={13} />
            <strong>
              {selected ? selectedSession?.title || "任务" : "新任务"}
            </strong>
          </div>
          <button
            className="soft-button open-project"
            disabled={!cwd}
            onClick={() => void act(() => api.call("revealProject", { cwd }))}
          >
            <FolderOpen size={14} />
            打开项目
          </button>
        </header>
        {(error || view.error) && (
          <div className="error-banner" role="alert">
            <span>{error || view.error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => {
                setError("");
                if (selected)
                  setViews((old) => ({
                    ...old,
                    [selected]: { ...old[selected], error: undefined },
                  }));
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <div
          className={`conversation ${view.rows.length ? "" : "empty"}`}
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el)
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 100;
          }}
        >
          {loading || loadingSession ? (
            <div className="loading-state">
              <LoaderCircle className="spin" size={22} />
              <p>{loading ? "正在连接 Bubble…" : "正在加载任务…"}</p>
            </div>
          ) : view.rows.length === 0 ? (
            <div className="welcome">
              <BubbleMark />
              <h1>今天，我们做点什么？</h1>
              <button
                className="welcome-project"
                title={cwd}
                onClick={() => void act(chooseProject)}
              >
                <Folder size={17} />
                {basename(cwd) || "选择项目"}
                <ChevronDown size={14} />
              </button>
              <p>从一个想法开始，让 Bubble 帮你实现。</p>
              <div className="suggestions">
                {[
                  {
                    icon: <Folder size={18} />,
                    title: "了解这个项目",
                    text: "梳理代码结构与主要模块",
                    prompt:
                      "请先阅读当前项目，介绍代码结构、主要模块和运行方式。只分析，不修改文件。",
                  },
                  {
                    icon: <FileCode2 size={18} />,
                    title: "检查代码",
                    text: "寻找问题，提出具体建议",
                    prompt:
                      "请检查当前项目的代码，找出值得优先修复的问题，提供文件位置与原因。先不要修改代码。",
                  },
                  {
                    icon: <Sparkles size={18} />,
                    title: "实现一个想法",
                    text: "把需求变成可运行的功能",
                    prompt: "我想在这个项目中实现一个新功能：",
                  },
                ].map((item) => (
                  <button
                    key={item.title}
                    className="suggestion"
                    onClick={() => {
                      setPrompt(item.prompt);
                      textarea.current?.focus();
                    }}
                  >
                    <span className="suggestion-icon">{item.icon}</span>
                    <strong>{item.title}</strong>
                    <span>{item.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="transcript">
              <Transcript
                rows={view.rows}
                active={view.active}
                waiting={view.interactions.length > 0}
                sessionKey={selected || "new"}
                choices={traceChoices}
                onChoice={(key, open) =>
                  setTraceChoices((old) => ({ ...old, [key]: open }))
                }
              />
              {view.interactions.map((item) => (
                <InteractionCard
                  key={item.id}
                  item={item}
                  onReply={async (id, value) => {
                    try {
                      await api.call("reply", { id, value });
                    } catch (e) {
                      handleError(e);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <div className="composer-area">
          <div className={`composer ${view.active ? "is-working" : ""}`}>
            <textarea
              ref={textarea}
              aria-label="发送给 Bubble 的消息"
              placeholder={
                view.active
                  ? "可以先写下下一步，等待当前任务完成…"
                  : "向 Bubble 描述你的任务…"
              }
              value={prompt}
              disabled={loading || hostFailed}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-controls">
              <div className="composer-options">
                <button
                  className="icon-button"
                  title="选择项目"
                  aria-label="选择项目"
                  disabled={!!selected}
                  onClick={() => void act(chooseProject)}
                >
                  <Plus size={19} />
                </button>
                <div className="model-control">
                  <button
                    className="model-button"
                    aria-expanded={picker}
                    onClick={() => setPicker((v) => !v)}
                  >
                    {currentModel?.name || model || "选择模型"}
                    <ChevronDown size={12} />
                  </button>
                  {picker && (
                    <>
                      <button
                        className="popover-dismiss"
                        aria-label="关闭模型选择"
                        onClick={() => setPicker(false)}
                      />
                      <div className="model-popover">
                        <div className="model-search">
                          <Search size={15} />
                          <input
                            autoFocus
                            aria-label="搜索模型"
                            placeholder="搜索模型或服务商…"
                            value={modelSearch}
                            onChange={(e) => setModelSearch(e.target.value)}
                          />
                        </div>
                        <div className="model-list">
                          {models
                            .filter((m) =>
                              `${m.name} ${m.provider}`
                                .toLowerCase()
                                .includes(modelSearch.toLowerCase()),
                            )
                            .map((m) => (
                              <button
                                key={m.id}
                                className={m.id === model ? "chosen" : ""}
                                onClick={() => {
                                  setModel(m.id);
                                  setPicker(false);
                                  setModelSearch("");
                                }}
                              >
                                <div>
                                  <span>{m.name}</span>
                                  <small>{m.provider}</small>
                                </div>
                                {m.id === model && <Check size={15} />}
                              </button>
                            ))}
                          {!models.length && (
                            <p className="muted">
                              暂未找到模型。请在设置中查看服务商配置。
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {!!currentModel?.reasoningLevels.length && (
                  <select
                    aria-label="推理强度"
                    value={effort}
                    onChange={(e) => setEffort(e.target.value)}
                  >
                    <option value="">默认强度</option>
                    {currentModel.reasoningLevels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {view.active ? (
                <button
                  className="send-button stop-button"
                  aria-label="停止生成"
                  onClick={() =>
                    void act(() => api.call("stop", { sessionId: selected }))
                  }
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送消息"
                  disabled={
                    !prompt.trim() ||
                    loading ||
                    loadingSession ||
                    sending ||
                    hostFailed ||
                    !model
                  }
                  onClick={() => void send()}
                >
                  {sending ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <ArrowUp size={19} />
                  )}
                </button>
              )}
            </div>
          </div>
          <div className="composer-footer">
            <div>
              <span className="local-dot" />
              本地 <span className="footer-divider">/</span>
              <ShieldCheck size={12} />
              <select
                aria-label="运行模式"
                value={mode}
                disabled={view.active}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="default">默认权限</option>
                <option value="plan">计划模式</option>
              </select>
            </div>
            <span>
              Enter 发送 <span className="footer-divider">·</span> Shift Enter
              换行
            </span>
          </div>
        </div>
      </main>
      {settings && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettings(false);
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="设置"
            onKeyDown={(e) => {
              if (e.key === "Escape") setSettings(false);
            }}
          >
            <header>
              <h2>设置</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setSettings(false)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="settings-body">
              <h3>外观</h3>
              <p className="muted">选择你喜欢的工作环境。</p>
              <div className="theme-options">
                {[
                  { id: "light", label: "浅色", icon: <Sun size={19} /> },
                  { id: "dark", label: "深色", icon: <Moon size={19} /> },
                  {
                    id: "system",
                    label: "跟随系统",
                    icon: <Monitor size={19} />,
                  },
                ].map((t) => (
                  <button
                    key={t.id}
                    className={preferences.theme === t.id ? "selected" : ""}
                    onClick={() =>
                      void act(async () => {
                        await api.call("theme", { theme: t.id });
                        setPreferences((old) => ({ ...old, theme: t.id }));
                      })
                    }
                  >
                    {t.icon}
                    {t.label}
                    {preferences.theme === t.id && <Check size={14} />}
                  </button>
                ))}
              </div>
              <h3>模型与服务商</h3>
              <p className="muted">
                沿用 Bubble
                的现有配置。配置文件修改后，重新启动桌面应用即可生效。
              </p>
              <div className="provider-list">
                {providers.map((p) => (
                  <div key={p.id}>
                    <span>{p.id}</span>
                    <span className="provider-status">
                      {p.hasApiKey ? (
                        <>
                          <Check size={12} />
                          已配置
                        </>
                      ) : (
                        "未配置密钥"
                      )}
                    </span>
                  </div>
                ))}
                {providers.length === 0 && <p>还没有配置服务商。</p>}
              </div>
              <button
                className="soft-button"
                onClick={() => void act(() => api.call("openSettings"))}
              >
                <FolderOpen size={15} />
                打开 Bubble 配置文件夹
              </button>
              <h3>关于 Bubble</h3>
              <p className="muted">
                桌面版 {preferences.version} · 本地会话，直接连接你的 Agent。
              </p>
              <div className="shortcut">
                <span>新建任务</span>
                <kbd>⌘ N</kbd>
              </div>
              <div className="shortcut">
                <span>打开设置</span>
                <kbd>⌘ ,</kbd>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
