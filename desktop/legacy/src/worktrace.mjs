/** Presentation only: no tool execution or inference from untrusted output. */
export function toolInput(row) {
  try {
    const value = JSON.parse(row.input || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
const text = (value) => (typeof value === "string" ? value.trim() : "");
const leaf = (path) =>
  path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || path;
export function toolPresentation(row) {
  const args = toolInput(row);
  const name = (row.name || "").toLowerCase();
  const path = text(
    args.path ||
      args.file_path ||
      args.file ||
      args.filePath ||
      args.absolute_path,
  );
  const command = text(args.command || args.cmd);
  const query = text(args.pattern || args.query || args.glob);
  const description = text(args.description || args.title);
  let kind = "other",
    action = "调用工具",
    target = description || row.name || "工具";
  if (["bash", "exec_command", "shell", "run_command"].includes(name)) {
    kind = "command";
    action = "执行命令";
    target = description || command || name;
  } else if (["read", "read_file", "readfile"].includes(name)) {
    kind = "read";
    action = "读取文件";
    target = leaf(path) || description || "文件";
  } else if (
    [
      "grep",
      "glob",
      "search",
      "search_files",
      "list",
      "ls",
      "list_directory",
    ].includes(name)
  ) {
    kind = "search";
    action = /^(list|ls|list_directory)$/.test(name) ? "列出文件" : "搜索";
    target = query || path || description || "项目文件";
  } else if (
    [
      "edit",
      "write",
      "edit_file",
      "write_file",
      "apply_patch",
      "patch",
    ].includes(name)
  ) {
    kind = "edit";
    action = /write/.test(name) ? "写入文件" : "修改文件";
    target = leaf(path) || description || "文件变更";
  } else if (
    ["task_output", "wait", "wait_agent", "wait_task"].includes(name)
  ) {
    kind = "wait";
    action = "等待任务";
    target =
      description ||
      (Array.isArray(args.task_ids) && args.task_ids.length
        ? `${args.task_ids.length} 个后台任务的结果`
        : "后台任务结果");
  } else if (
    ["spawn_agent", "task", "run_agent", "send_message", "send_input"].includes(
      name,
    )
  ) {
    kind = "agent";
    action = "协作任务";
    target = description || text(args.task_name || args.nickname) || "子 Agent";
  } else if (/web_?search|web_?fetch|browse/.test(name)) {
    kind = "web";
    action = /search/.test(name) ? "搜索网页" : "获取网页";
    target = query || text(args.url) || description || "网页";
  } else if (/memory/.test(name)) {
    kind = "memory";
    action = "查阅记忆";
    target = description || query || path || "记忆";
  } else if (/tool_search/.test(name)) {
    kind = "search";
    action = "查找工具";
    target = query || description || "可用工具";
  }
  return { kind, action, target, command, path, query, description };
}
export function formatElapsed(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ""}`;
}
export function stageEntries(rows) {
  const stages = [];
  for (const row of rows) {
    if (row.kind === "step") continue;
    const info = row.kind === "tool" ? toolPresentation(row) : null;
    const kind =
      info && ["read", "search"].includes(info.kind)
        ? "explore"
        : info?.kind || row.kind;
    const previous = stages.at(-1);
    // Only adjacent similar operations coalesce; narration is a hard boundary.
    if (
      row.kind === "tool" &&
      previous?.kind === kind &&
      previous.rows[0].kind === "tool"
    )
      previous.rows.push(row);
    else
      stages.push({
        id: row.id || `entry-${stages.length}`,
        kind,
        rows: [row],
      });
  }
  return stages;
}
export function stageSummary(stage) {
  const running = stage.rows.filter((r) => r.status === "running");
  const errors = stage.rows.filter((r) => r.status === "error").length;
  const interrupted = stage.rows.some((r) => r.status === "interrupted");
  const state = running.length
    ? "running"
    : errors
      ? "error"
      : interrupted
        ? "interrupted"
        : "done";
  const current = running.at(-1);
  if (current) {
    const p = toolPresentation(current);
    const verbs = {
      command: "正在执行",
      read: "正在读取",
      search: "正在搜索",
      edit: "正在修改",
      wait: "正在等待",
      agent: "正在协作",
      web: "正在检索网页",
      memory: "正在查阅记忆",
    };
    return {
      label: `${verbs[p.kind] || "正在调用"} ${p.target}`,
      state,
      errors,
    };
  }
  if (stage.kind === "explore") {
    const files = new Set(
      stage.rows
        .filter((r) => toolPresentation(r).kind === "read")
        .map((r) => toolPresentation(r).path || r.id),
    );
    const searches = stage.rows.filter(
      (r) => toolPresentation(r).kind === "search",
    ).length;
    const parts = [
      files.size ? `${files.size} 个文件` : "",
      searches ? `${searches} 次搜索` : "",
    ].filter(Boolean);
    return {
      label: `${state === "interrupted" ? "探索已中断" : state === "error" ? "探索出现错误" : "已探索"} ${parts.join("、")}`,
      state,
      errors,
    };
  }
  if (stage.rows.length === 1) {
    const p = toolPresentation(stage.rows[0]);
    const verbs = {
      command: "已执行",
      edit: "已修改",
      wait: "已获取",
      agent: "协作任务",
      web: "已检索",
      memory: "已查阅",
    };
    return {
      label: `${state === "interrupted" ? "已中断" : state === "error" ? "执行失败" : verbs[p.kind] || p.action} ${p.target}`,
      state,
      errors,
    };
  }
  const labels = {
    command: "条命令",
    edit: "项文件操作",
    wait: "次任务等待",
    agent: "项协作任务",
    web: "次网页操作",
    memory: "次记忆查阅",
  };
  return {
    label: `${state === "interrupted" ? "已中断" : "已执行"} ${stage.rows.length} ${labels[stage.kind] || "项操作"}`,
    state,
    errors,
  };
}
/** Keep a turn's work before its final answer, without hiding commentary mid-run. */
export function conversationTurns(rows, active = false) {
  const turns = [];
  let current;
  for (const row of rows) {
    if (row.kind === "user" || !current) {
      current = {
        id: `turn-${turns.length}`,
        user: row.kind === "user" ? row : null,
        rows: [],
      };
      turns.push(current);
      if (row.kind === "user") continue;
    }
    current.rows.push(row);
  }
  return turns.map((turn, index) => {
    const live = active && index === turns.length - 1;
    const visible = turn.rows.filter((r) => r.kind !== "step");
    const last = visible.at(-1);
    const hasActivity = visible.some(
      (r) => r.kind === "tool" || r.kind === "reasoning",
    );
    const final =
      last?.kind === "assistant" && (!live || last.final || !hasActivity)
        ? last
        : null;
    const work = final ? visible.slice(0, -1) : visible;
    const tools = work.filter((r) => r.kind === "tool");
    return {
      ...turn,
      live,
      final,
      work,
      toolCount: tools.length,
      failedCount: tools.filter((r) => r.status === "error").length,
      interrupted:
        turn.user?.outcome === "cancelled" ||
        tools.some((r) => r.status === "interrupted"),
      failed:
        turn.user?.outcome === "failed" || work.some((r) => r.kind === "error"),
      startedAt: turn.user?.startedAt,
      endedAt: turn.user?.endedAt,
    };
  });
}
