/**
 * In-chat slash-command parser and handlers.
 *
 * Commands run synchronously (no agent involvement) and reply with a plain
 * text or markdown message. Admin commands silently no-op for non-admins
 * (no error reply — that would expose the bot's existence).
 */

import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { BubbleChannel } from "../channel/channel.js";
import type { ScopeRegistry } from "../scope/scope-registry.js";
import type { SessionStore } from "../scope/session-store.js";
import type { SessionBinder } from "../scope/session-binder.js";
import type { ActiveRuns } from "../runtime/active-runs.js";
import type { ScopeConfig, ScopeKey } from "../types.js";
import { formatPermissionMode, isPermissionModeName } from "../format.js";
import type { PermissionMode } from "../../types.js";

export interface CommandContext {
  channel: BubbleChannel;
  scopeRegistry: ScopeRegistry;
  sessionStore: SessionStore;
  sessionBinder: SessionBinder;
  activeRuns: ActiveRuns;
}

export interface CommandInput {
  chatId: string;
  userId: string;
  scope: ScopeConfig;
  scopeKey: ScopeKey;
  raw: string;
  /** Reply target for ephemeral confirms. */
  replyTo?: string;
}

export type CommandHandler = (input: CommandInput, args: string, ctx: CommandContext) => Promise<void>;

interface CommandDef {
  name: string;
  description: string;
  adminOnly: boolean;
  handler: CommandHandler;
}

const COMMANDS: CommandDef[] = [];

function register(def: CommandDef): void {
  COMMANDS.push(def);
}

export function isSlashCommand(text: string): boolean {
  const t = text.trim();
  return t.startsWith("/") && !t.startsWith("//");
}

/**
 * Try to dispatch a slash command. Returns true if a command was matched
 * and handled (regardless of success). Returns false if no command matched
 * — caller should treat the message as a normal agent prompt.
 */
export async function dispatchCommand(input: CommandInput, ctx: CommandContext): Promise<boolean> {
  const t = input.raw.trim();
  if (!isSlashCommand(t)) return false;
  const space = t.indexOf(" ");
  const head = (space === -1 ? t : t.slice(0, space)).toLowerCase();
  const args = space === -1 ? "" : t.slice(space + 1).trim();

  const def = COMMANDS.find((c) => `/${c.name}` === head);
  if (!def) {
    await ctx.channel.send(input.chatId, {
      text: `未知命令 ${head}。发 /help 查看可用命令。`,
    }, input.replyTo ? { replyTo: input.replyTo } : undefined);
    return true;
  }

  if (def.adminOnly && !input.scope.admins.includes(input.userId)) {
    // Silent drop for non-admins.
    return true;
  }

  await def.handler(input, args, ctx);
  return true;
}

// ---- /help ----
register({
  name: "help",
  description: "列出可用命令",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const isAdmin = input.scope.admins.includes(input.userId);
    const lines = ["**Bubble 飞书命令**"];
    for (const c of COMMANDS) {
      if (c.adminOnly && !isAdmin) continue;
      lines.push(`- \`/${c.name}\` — ${c.description}`);
    }
    await ctx.channel.send(input.chatId, { text: lines.join("\n") });
  },
});

// ---- /status ----
register({
  name: "status",
  description: "显示当前 scope / session / mode / 网络状态",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const entry = ctx.sessionStore.get(input.scopeKey);
    const wsStatus = ctx.channel.getStatus();
    const active = ctx.activeRuns.isActive(input.scopeKey);
    const lines = [
      `📁 cwd: \`${entry?.cwd ?? input.scope.cwd}\``,
      `🛡 mode: \`${formatPermissionMode(entry?.permissionMode ?? input.scope.defaultPermissionMode)}\``,
      `📄 session: \`${entry?.sessionFile ?? "(not yet started)"}\``,
      `🔌 ws: \`${wsStatus?.state ?? "unknown"}\``,
      `🤖 run: ${active ? "运行中" : "空闲"}`,
    ];
    await ctx.channel.send(input.chatId, { text: lines.join("\n") });
  },
});

// ---- /cwd ----
register({
  name: "cwd",
  description: "显示当前 cwd",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const entry = ctx.sessionStore.get(input.scopeKey);
    const cwd = entry?.cwd ?? input.scope.cwd;
    await ctx.channel.send(input.chatId, { text: `📁 \`${cwd}\`` });
  },
});

// ---- /cd ----
register({
  name: "cd",
  description: "切换到新目录并开新 session（绝对路径或 ~/...）",
  adminOnly: false,
  handler: async (input, args, ctx) => {
    if (!args) {
      await ctx.channel.send(input.chatId, { text: "用法：`/cd /absolute/path` 或 `/cd ~/projects/foo`" });
      return;
    }
    const target = expandUser(args);
    if (!isAbsolutePath(target)) {
      await ctx.channel.send(input.chatId, { text: "❌ 路径必须是绝对路径或以 ~ 开头" });
      return;
    }
    const resolved = resolvePath(target);
    if (!existsSync(resolved)) {
      await ctx.channel.send(input.chatId, { text: `❌ 路径不存在：\`${resolved}\`` });
      return;
    }
    let isDir = false;
    try { isDir = statSync(resolved).isDirectory(); } catch { /* */ }
    if (!isDir) {
      await ctx.channel.send(input.chatId, { text: `❌ 不是目录：\`${resolved}\`` });
      return;
    }
    // Abort any in-flight run for this scope before swapping cwd.
    ctx.activeRuns.abort(input.scopeKey);
    const next = ctx.sessionBinder.changeCwd(input.scopeKey, resolved);
    await ctx.channel.send(input.chatId, {
      text: `✅ 已切换到 \`${next.cwd}\`，开新 session。`,
    });
  },
});

// ---- /mode ----
register({
  name: "mode",
  description: "切换 permission mode（default / plan / bypassPermissions）",
  adminOnly: false,
  handler: async (input, args, ctx) => {
    if (!args) {
      const entry = ctx.sessionStore.get(input.scopeKey);
      const current = entry?.permissionMode ?? input.scope.defaultPermissionMode;
      await ctx.channel.send(input.chatId, {
        text: `当前 mode: \`${formatPermissionMode(current)}\`\n用法：\`/mode <name>\` (default/plan/bypassPermissions)`,
      });
      return;
    }
    if (!isPermissionModeName(args)) {
      await ctx.channel.send(input.chatId, {
        text: `❌ 无效 mode \`${args}\`。可选：default / plan / bypassPermissions`,
      });
      return;
    }
    const mode: PermissionMode = args;
    // Ensure session entry exists so we have something to update.
    const entry = ctx.sessionStore.get(input.scopeKey);
    if (!entry) {
      // Bootstrap session at fallback cwd, then set mode.
      ctx.sessionBinder.openOrBootstrap(input.scopeKey, input.scope.cwd, mode);
    } else {
      ctx.sessionStore.setPermissionMode(input.scopeKey, mode);
    }
    await ctx.channel.send(input.chatId, {
      text: `🛡 mode 已切换为 \`${formatPermissionMode(mode)}\``,
    });
  },
});

// ---- /new ----
register({
  name: "new",
  description: "归档当前 session，开始新对话",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    ctx.activeRuns.abort(input.scopeKey);
    const entry = ctx.sessionStore.get(input.scopeKey);
    const cwd = entry?.cwd ?? input.scope.cwd;
    const mode = entry?.permissionMode ?? input.scope.defaultPermissionMode;
    ctx.sessionBinder.createFresh(input.scopeKey, cwd, mode);
    await ctx.channel.send(input.chatId, { text: "✨ 已开新 session。" });
  },
});

// ---- /resume ----
register({
  name: "resume",
  description: "列出最近 session 让你选（不带参数）或恢复指定 session 名",
  adminOnly: false,
  handler: async (input, args, ctx) => {
    const entry = ctx.sessionStore.get(input.scopeKey);
    const cwd = entry?.cwd ?? input.scope.cwd;
    if (!args) {
      const recent = ctx.sessionBinder.listResumable(cwd, 10);
      if (recent.length === 0) {
        await ctx.channel.send(input.chatId, { text: "（这个目录下还没有 session 可恢复）" });
        return;
      }
      const lines = ["最近 session：", ""];
      for (const s of recent) {
        const stamp = new Date(s.mtime).toISOString().slice(0, 19).replace("T", " ");
        lines.push(`- \`${s.name}\` · ${stamp} · ${s.messageCount} msgs · ${s.firstUserMessage.slice(0, 50)}`);
      }
      lines.push("");
      lines.push("用 `/resume <name>` 恢复。");
      await ctx.channel.send(input.chatId, { text: lines.join("\n") });
      return;
    }
    const recent = ctx.sessionBinder.listResumable(cwd, 50);
    const match = recent.find((s) => s.name === args || s.file.endsWith(args));
    if (!match) {
      await ctx.channel.send(input.chatId, { text: `❌ 没找到 session \`${args}\`` });
      return;
    }
    ctx.activeRuns.abort(input.scopeKey);
    const opened = ctx.sessionBinder.resumeNamed(input.scopeKey, match.file);
    if (!opened) {
      await ctx.channel.send(input.chatId, { text: `❌ 恢复失败：\`${args}\`` });
      return;
    }
    await ctx.channel.send(input.chatId, { text: `✅ 已恢复 \`${match.name}\` (cwd: ${opened.cwd})` });
  },
});

// ---- /stop ----
register({
  name: "stop",
  description: "中断当前运行",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const aborted = ctx.activeRuns.abort(input.scopeKey);
    await ctx.channel.send(input.chatId, {
      text: aborted ? "⏹ 已请求中断。" : "（当前没有正在运行的任务）",
    });
  },
});

// ---- /clear ----
register({
  name: "clear",
  description: "在当前 session 里插入清除标记（保留历史文件，但后续对话不再带入旧上下文）",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const entry = ctx.sessionStore.get(input.scopeKey);
    if (!entry) {
      await ctx.channel.send(input.chatId, { text: "（还没有 session 可清除）" });
      return;
    }
    const opened = ctx.sessionBinder.openOrBootstrap(input.scopeKey, entry.cwd, entry.permissionMode);
    opened.manager.appendMarker("conversation_clear", String(Date.now()));
    await ctx.channel.send(input.chatId, { text: "🧹 已插入清除标记。下次发消息从空上下文开始。" });
  },
});

// ---- /whoami ----
register({
  name: "whoami",
  description: "显示你的 open_id",
  adminOnly: false,
  handler: async (input, _args, ctx) => {
    const isAdmin = input.scope.admins.includes(input.userId) ? "（admin）" : "";
    await ctx.channel.send(input.chatId, {
      text: `👤 \`${input.userId}\` ${isAdmin}`,
    });
  },
});

// ---- /config ----
register({
  name: "config",
  description: "[admin] 显示当前 scope 配置（只读）",
  adminOnly: true,
  handler: async (input, _args, ctx) => {
    const lines = [
      "**scope 配置：**",
      `- chatId: \`${input.chatId}\``,
      `- displayName: \`${input.scope.displayName}\``,
      `- initial cwd: \`${input.scope.cwd}\``,
      `- defaultPermissionMode: \`${formatPermissionMode(input.scope.defaultPermissionMode)}\``,
      `- allowedUsers (${input.scope.allowedUsers.length}):`,
      ...input.scope.allowedUsers.map((u) => `  - \`${u}\``),
      `- admins (${input.scope.admins.length}):`,
      ...input.scope.admins.map((u) => `  - \`${u}\``),
    ];
    await ctx.channel.send(input.chatId, { text: lines.join("\n") });
  },
});

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return homedir() + p.slice(1);
  }
  return p;
}

export function listCommandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}
