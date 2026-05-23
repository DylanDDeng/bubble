/**
 * `/feishu` slash command — control the Feishu remote-access serve process
 * from inside the Bubble TUI without leaving it.
 *
 * Subcommands:
 *   /feishu              equivalent to `/feishu status`
 *   /feishu status       show running state and configured scopes
 *   /feishu start        spawn `bubble serve --feishu` detached
 *   /feishu stop         SIGTERM the running serve instance
 *   /feishu logs [N]     tail last N lines of today's log (default 30)
 *
 * The serve subprocess runs independently of the TUI — closing the TUI
 * does not stop it. Use `/feishu stop` (or kill the PID directly) to
 * terminate.
 */

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configExists, loadConfig } from "../feishu/config.js";
import { getConfigPath, getLogsDir } from "../feishu/paths.js";
import { ProcessRegistry } from "../feishu/process-registry.js";
import { ScopeRegistry } from "../feishu/scope/scope-registry.js";
import type { SlashCommand, SlashCommandContext } from "./types.js";

const SUBCOMMANDS = ["status", "setup", "start", "stop", "logs", "discover", "bind"] as const;

export const feishuCommand: SlashCommand = {
  name: "feishu",
  description: "Control the Feishu remote-access service (setup/status/start/stop/logs/discover/bind)",
  async handler(args, ctx) {
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const cmd = (sub ?? "status").toLowerCase();
    if (!(SUBCOMMANDS as readonly string[]).includes(cmd)) {
      return `Unknown subcommand \`${cmd}\`. Usage: /feishu [setup|status|start|stop|logs|discover|bind]`;
    }
    switch (cmd) {
      case "setup":
        return runSetup(ctx);
      case "status":
        return runStatus();
      case "start":
        return runStart();
      case "stop":
        return runStop();
      case "logs":
        return runLogs(parseInt(rest[0] ?? "30", 10));
      case "discover":
        return runDiscover();
      case "bind":
        return runBind(rest);
      default:
        return "";
    }
  },
};

function runSetup(ctx: SlashCommandContext): string | void {
  if (!ctx.openPicker) {
    return "Setup wizard is only available in interactive TUI mode. Run `bubble serve --feishu --setup` from a shell instead.";
  }
  if (configExists()) {
    return [
      "已检测到现有 config (`~/.bubble/feishu/config.json`)。重新 setup 会覆盖现有的应用注册。",
      "",
      "如果只是想加新的 chat scope，编辑 `~/.bubble/feishu/scopes.json` 即可；要重置则先 `rm ~/.bubble/feishu/config.json ~/.bubble/feishu/secrets.enc` 再运行 `/feishu setup`。",
    ].join("\n");
  }
  ctx.openPicker("feishu-setup");
}

function runStatus(): string {
  if (!configExists()) {
    return [
      "Feishu serve is **not configured**.",
      "",
      "Run from a shell: `bubble serve --feishu --setup` to scan the QR code and create config.",
      `Config path: \`${getConfigPath()}\``,
    ].join("\n");
  }
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return `Failed to read config: ${(err as Error).message}`;
  }

  const procRegistry = new ProcessRegistry();
  const conflicts = procRegistry.findConflicts(config.app.appId);
  const running = conflicts.length > 0;

  let scopesCount = 0;
  try {
    scopesCount = ScopeRegistry.load().list().length;
  } catch {
    // ignore
  }

  const lines: string[] = [];
  lines.push(`**Feishu serve status**`);
  lines.push(`- app: \`${config.app.appId}\``);
  lines.push(`- owner: \`${config.app.ownerOpenId}\``);
  lines.push(`- scopes configured: ${scopesCount}`);
  if (running) {
    const pids = conflicts.map((c) => c.entry.pid).join(", ");
    lines.push(`- 🟢 running (pid ${pids})`);
    lines.push(`  use \`/feishu stop\` to terminate, \`/feishu logs\` to tail logs`);
  } else {
    lines.push(`- ⚪ not running`);
    lines.push(`  use \`/feishu start\` to launch`);
  }
  return lines.join("\n");
}

function runStart(): string {
  if (!configExists()) {
    return [
      "Cannot start: no Feishu config found.",
      "",
      "Run from a shell first: `bubble serve --feishu --setup`",
      "(the wizard needs an interactive terminal to scan the QR code).",
    ].join("\n");
  }
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return `Failed to read config: ${(err as Error).message}`;
  }

  // Bail if already running for this appId.
  const procRegistry = new ProcessRegistry();
  procRegistry.gc();
  if (procRegistry.findConflicts(config.app.appId).length > 0) {
    return "Feishu serve is already running. Use `/feishu status` for details.";
  }

  // Spawn detached subprocess. Redirect stdout/stderr to a log file so we
  // don't fight the TUI for the terminal. Use process.execPath + argv[1] so
  // the subprocess inherits whatever way the user launched the TUI (npm bin,
  // node dist/main.js, bun dist/main.js, etc.).
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return "Cannot determine bubble script path; please launch from shell instead.";
  }
  const stdoutLog = join(getLogsDir(), "serve-stdout.log");
  const stderrLog = join(getLogsDir(), "serve-stderr.log");
  let outFd: number;
  let errFd: number;
  try {
    outFd = openSync(stdoutLog, "a");
    errFd = openSync(stderrLog, "a");
  } catch (err) {
    return `Failed to open log files: ${(err as Error).message}`;
  }

  let child;
  try {
    child = spawn(process.execPath, [scriptPath, "serve", "--feishu"], {
      detached: true,
      stdio: ["ignore", outFd, errFd],
      env: { ...process.env },
    });
  } catch (err) {
    return `Failed to spawn: ${(err as Error).message}`;
  }
  // unref so the parent (TUI) can exit without waiting for the child.
  child.unref();
  // If spawn failed asynchronously, we won't catch it here — the user will
  // see emptiness in /feishu status, which then prompts them to check logs.

  return [
    `🚀 Started Feishu serve (pid ${child.pid ?? "?"}).`,
    `  stdout: \`${stdoutLog}\``,
    `  stderr: \`${stderrLog}\``,
    "",
    "Use `/feishu status` to verify, `/feishu logs` to tail.",
  ].join("\n");
}

function runStop(): string {
  if (!configExists()) return "No config — nothing to stop.";
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return `Failed to read config: ${(err as Error).message}`;
  }
  const procRegistry = new ProcessRegistry();
  const conflicts = procRegistry.findConflicts(config.app.appId);
  if (conflicts.length === 0) {
    return "Feishu serve is not running.";
  }
  const killed = procRegistry.killConflicts(config.app.appId);
  if (killed === 0) {
    return "Found stale registry entries but no live processes — cleaned up.";
  }
  return `⏹ Sent SIGTERM to ${killed} process(es). Use \`/feishu status\` to confirm shutdown.`;
}

function runDiscover(): string {
  if (!configExists()) {
    return "未配置。先跑 `/feishu setup`。";
  }
  let config;
  try { config = loadConfig(); } catch (err) {
    return `Failed to read config: ${(err as Error).message}`;
  }

  // Scan today's + yesterday's log for `scope_not_found` (or user_not_allowed)
  // events. Most recent first.
  const events = collectGateEvents();
  if (events.length === 0) {
    return [
      "没找到未授权的 chat 记录。",
      "",
      "确保：",
      "1. `/feishu start` 已经把服务跑起来了（`/feishu status` 看一下）",
      "2. 你已经在手机飞书里给 bot 发过至少一条消息",
      "3. 如果之前测试过，可能已经被 `requireMentionInGroup` 过滤；用私聊试试",
    ].join("\n");
  }
  const known = new Set(loadKnownChats());
  const unknown = events.filter((e) => !known.has(e.chatId));
  if (unknown.length === 0) {
    return [
      "找到的 chat 都已经配置过了：",
      ...events.slice(0, 5).map((e) => `- ${e.chatId} (user ${e.userId}, ${e.reason})`),
    ].join("\n");
  }

  const lines: string[] = [
    `发现 ${unknown.length} 个未授权的 chat：`,
    "",
  ];
  // Group by chatId, keep latest senderId per chat.
  const byChat = new Map<string, { userId: string; reason: string; ts: string }>();
  for (const e of unknown) {
    if (!byChat.has(e.chatId)) byChat.set(e.chatId, e);
  }
  let idx = 1;
  for (const [chatId, info] of byChat.entries()) {
    lines.push(`${idx}. \`${chatId}\``);
    lines.push(`   sender: \`${info.userId}\`  ·  ${info.reason}  ·  ${info.ts}`);
    lines.push(`   → \`/feishu bind ${chatId} <你的项目路径>\``);
    lines.push("");
    idx++;
  }
  lines.push(`(owner open_id = \`${config.app.ownerOpenId}\`，会自动加入新 scope 的 allowedUsers)`);
  return lines.join("\n");
}

interface GateEvent {
  chatId: string;
  userId: string;
  reason: string;
  ts: string;
}

function collectGateEvents(): GateEvent[] {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const dates = [iso(today), iso(yesterday)];
  const all: GateEvent[] = [];
  for (const d of dates) {
    const path = join(getLogsDir(), `${d}.log`);
    if (!existsSync(path)) continue;
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.msg !== "gate_rejected") continue;
        all.push({
          chatId: String(obj.chatId ?? ""),
          userId: String(obj.userId ?? ""),
          reason: String(obj.reason ?? ""),
          ts: String(obj.ts ?? "").slice(11, 19),
        });
      } catch { /* skip */ }
    }
  }
  return all.reverse(); // newest first
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadKnownChats(): string[] {
  try {
    return ScopeRegistry.load().list().map((s) => s.chatId);
  } catch {
    return [];
  }
}

function runBind(args: string[]): string {
  if (!configExists()) {
    return "未配置。先跑 `/feishu setup`。";
  }
  let config;
  try { config = loadConfig(); } catch (err) {
    return `Failed to read config: ${(err as Error).message}`;
  }

  if (args.length < 2) {
    return [
      "用法：`/feishu bind <chat_id> <cwd> [display_name]`",
      "",
      "示例：`/feishu bind oc_abc123 ~/projects/my-app my-app`",
      "",
      "用 `/feishu discover` 找到未授权的 chat_id。",
    ].join("\n");
  }
  const chatId = args[0]!.trim();
  const cwdRaw = args[1]!.trim();
  const displayName = args.slice(2).join(" ").trim();

  // Expand ~
  const cwd = (cwdRaw === "~" || cwdRaw.startsWith("~/"))
    ? (process.env.HOME ?? "") + cwdRaw.slice(1)
    : cwdRaw;

  // Validate
  let stat;
  try { stat = existsSync(cwd) ? statSync(cwd) : undefined; } catch { stat = undefined; }
  if (!stat || !stat.isDirectory()) {
    return `❌ cwd 无效（不存在或不是目录）：\`${cwd}\``;
  }
  if (!chatId.startsWith("oc_")) {
    // Not strictly required, but worth flagging.
    return `⚠️ chat_id 看起来不像飞书的（一般以 \`oc_\` 开头）。确认无误后强制添加请直接编辑 \`~/.bubble/feishu/scopes.json\`。收到：\`${chatId}\``;
  }

  const registry = ScopeRegistry.load();
  if (registry.has(chatId)) {
    return `⚠️ scope \`${chatId}\` 已存在。如果想改 cwd，先 \`rm ~/.bubble/feishu/scopes.json\` 里手动调，或者用 \`/cd\` 在飞书会话里切换。`;
  }
  const finalName = displayName || basenameOf(cwd);
  registry.upsert(chatId, {
    cwd,
    displayName: finalName,
    allowedUsers: [config.app.ownerOpenId],
    admins: [config.app.ownerOpenId],
    defaultPermissionMode: "default",
    model: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  return [
    `✅ 已绑定 scope：`,
    `   chat: \`${chatId}\``,
    `   cwd:  \`${cwd}\``,
    `   name: \`${finalName}\``,
    `   allowedUsers: [\`${config.app.ownerOpenId}\`]`,
    "",
    "现在去飞书重新发条消息，应该能看到卡片回复了。",
  ].join("\n");
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function runLogs(n: number): string {
  const tailN = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 30;
  const dateKey = new Date().toISOString().slice(0, 10);
  const path = join(getLogsDir(), `${dateKey}.log`);
  if (!existsSync(path)) {
    // Fall back to the most recent log file in the dir.
    return `No log file for today yet (\`${path}\`). Start the service first or check \`${getLogsDir()}\`.`;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return `Failed to read log: ${(err as Error).message}`;
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const slice = lines.slice(-tailN);
  if (slice.length === 0) return `(log is empty: \`${path}\`)`;
  // Format JSON lines compactly for readability in chat.
  const formatted = slice.map((line) => {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const ts = String(obj.ts ?? "").slice(11, 19);
      const lvl = String(obj.level ?? "?").padEnd(5);
      const msg = String(obj.msg ?? "");
      const extra = Object.entries(obj)
        .filter(([k]) => !["ts", "level", "msg"].includes(k))
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return `${ts} ${lvl} ${msg}${extra ? "  " + extra : ""}`;
    } catch {
      return line;
    }
  });
  return ["```", ...formatted, "```", `(${slice.length} lines from \`${path}\`)`].join("\n");
}
