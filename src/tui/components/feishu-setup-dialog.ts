import chalk from "chalk";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import qrTerminal from "qrcode-terminal";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@bubblebrain-ai/pi-tui";
import { bootstrapConfig } from "../../feishu/config.js";
import { ScopeRegistry } from "../../feishu/scope/scope-registry.js";
import type { ScopeConfig } from "../../feishu/types.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeDim, themeForeground } from "../model/theme-style.js";
import { paintSheetLine, padSheetLine, safeSheetInlineText, safeSheetText } from "./bottom-sheet.js";

type RegistrationResult = {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string };
};

interface RegistrationOptions {
  signal: AbortSignal;
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange(info: { status: string }): void;
}

type SetupStage =
  | { kind: "registering" }
  | { kind: "qr"; url: string; ascii: string; status: string }
  | { kind: "credentialed"; ownerOpenId: string }
  | {
      kind: "binding";
      ownerOpenId: string;
      field: keyof BindingValues;
      values: BindingValues;
      error?: string;
    }
  | { kind: "error"; message: string };

interface BindingValues {
  chatId: string;
  cwd: string;
  displayName: string;
}

export type FeishuSetupResult =
  | { kind: "completed"; summary: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface FeishuSetupDialogOptions {
  getTerminalRows(): number;
  getTheme?: () => Theme;
  register?: (options: RegistrationOptions) => Promise<RegistrationResult>;
  renderQr?: (url: string) => Promise<string>;
  saveCredentials?: (input: { appId: string; appSecret: string; ownerOpenId: string }) => void;
  saveScope?: (chatId: string, scope: ScopeConfig) => void;
  onResult(result: FeishuSetupResult): void;
  onRender(): void;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Interactive Feishu registration and first-chat binding workflow for Pi TUI. */
export class FeishuSetupDialogComponent implements Component, Focusable {
  focused = false;
  private stage: SetupStage = { kind: "registering" };
  private readonly abortController = new AbortController();
  private settled = false;

  constructor(private readonly options: FeishuSetupDialogOptions) {}

  start(): void {
    const register = this.options.register ?? ((options) => registerApp(options) as Promise<RegistrationResult>);
    void register({
      signal: this.abortController.signal,
      onQRCodeReady: (info) => {
        void (this.options.renderQr ?? renderQr)(info.url).then((ascii) => {
          if (this.settled || this.abortController.signal.aborted) return;
          this.stage = { kind: "qr", url: info.url, ascii, status: "等待扫码…" };
          this.options.onRender();
        });
      },
      onStatusChange: (info) => {
        if (this.stage.kind !== "qr") return;
        this.stage = { ...this.stage, status: registrationStatus(info.status) };
        this.options.onRender();
      },
    }).then((result) => {
      if (this.settled || this.abortController.signal.aborted) return;
      const ownerOpenId = result.user_info?.open_id;
      if (!ownerOpenId) {
        this.showError("授权成功但没有返回 owner open_id，无法继续。");
        return;
      }
      try {
        (this.options.saveCredentials ?? bootstrapConfig)({
          appId: result.client_id,
          appSecret: result.client_secret,
          ownerOpenId,
        });
      } catch (error) {
        this.showError(`保存 Feishu 配置失败：${errorMessage(error)}`);
        return;
      }
      this.stage = { kind: "credentialed", ownerOpenId };
      this.options.onRender();
    }).catch((error: unknown) => {
      if (this.settled || this.abortController.signal.aborted) return;
      this.showError(errorMessage(error) || "扫码注册失败");
    });
  }

  render(width: number): string[] {
    const theme = this.options.getTheme?.() ?? darkTheme;
    const safeWidth = Math.max(1, width);
    const terminalRows = Math.max(1, this.options.getTerminalRows());
    const sheetRows = terminalRows > 1 ? terminalRows - 1 : 1;
    const showHelp = sheetRows >= 4;
    const budget = Math.max(1, sheetRows - (showHelp ? 1 : 0));
    const rows = this.renderStage(safeWidth, budget, theme)
      .slice(0, budget)
      .map((line) => paintSheetLine(line, safeWidth, false, theme));
    if (!showHelp) return rows;
    return [...rows, themeDim(theme.dim, padSheetLine(this.helpText(), safeWidth))];
  }

  handleInput(data: string): void {
    if (this.settled) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.stage.kind === "credentialed" || this.stage.kind === "binding") {
        this.finish({
          kind: "completed",
          summary: `✅ Feishu 应用已注册并保存。owner: ${this.stage.ownerOpenId}\n已跳过 chat 绑定；启动服务后可用 /feishu discover 和 /feishu bind 完成绑定。`,
        });
      } else {
        this.finish({ kind: "cancelled" });
      }
      return;
    }

    if (this.stage.kind === "error") {
      if (matchesKey(data, "enter") || data === " ") {
        this.finish({ kind: "error", message: this.stage.message });
      }
      return;
    }

    if (this.stage.kind === "credentialed") {
      if (matchesKey(data, "enter")) {
        this.stage = {
          kind: "binding",
          ownerOpenId: this.stage.ownerOpenId,
          field: "chatId",
          values: { chatId: "", cwd: "", displayName: "" },
        };
        this.options.onRender();
      }
      return;
    }

    if (this.stage.kind !== "binding") return;
    if (matchesKey(data, "enter")) {
      this.advanceBinding();
      return;
    }
    if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
      this.updateBinding(removeLastGrapheme(this.stage.values[this.stage.field]));
      return;
    }
    if (matchesKey(data, "tab") && this.stage.field === "displayName") {
      this.updateBinding(basename(this.stage.values.cwd));
      return;
    }
    const printable = printableInput(data);
    if (printable !== undefined) {
      this.updateBinding(this.stage.values[this.stage.field] + safeSheetText(printable).replace(/\n/g, " "));
    }
  }

  invalidate(): void {}

  dispose(): void {
    if (this.settled) return;
    this.settled = true;
    this.abortController.abort();
  }

  private renderStage(width: number, budget: number, theme: Theme): string[] {
    const indentWidth = width >= 12 ? 2 : width >= 3 ? 1 : 0;
    const indent = " ".repeat(indentWidth);
    const contentWidth = Math.max(1, width - indentWidth * 2);
    const title = `${indent}${chalk.bold(themeForeground(theme.inputText, "Feishu Setup"))}`;
    if (this.stage.kind === "registering") {
      return [title, "", `${indent}${themeDim(theme.dim, "正在向飞书申请注册码…")}`].slice(0, budget);
    }
    if (this.stage.kind === "qr") {
      const fixedRows = 4;
      const qr = safeSheetText(this.stage.ascii).split("\n").filter((line, index, rows) => line || index < rows.length - 1);
      const canShowQr = qr.length > 0 && qr.length <= Math.max(0, budget - fixedRows);
      const urlRows = wrapTextWithAnsi(this.stage.url, contentWidth)
        .map((line) => `${indent}${themeForeground(theme.accent, line)}`);
      return [
        title,
        `${indent}${themeDim(theme.dim, this.stage.status)}`,
        ...(canShowQr
          ? qr.map((line) => `${indent}${truncateToWidth(line, contentWidth, "")}`)
          : [`${indent}${themeForeground(theme.warning, "终端高度不足以完整显示二维码，请在浏览器打开下面的链接：")}`]),
        ...urlRows,
      ].slice(0, budget);
    }
    if (this.stage.kind === "credentialed") {
      return [
        title,
        "",
        `${indent}${themeForeground(theme.success, "✅ 注册成功")}`,
        `${indent}${themeForeground(theme.inputText, `owner open_id: ${safeSheetInlineText(this.stage.ownerOpenId)}`)}`,
        `${indent}${themeDim(theme.dim, "配置与加密密钥已写入 ~/.bubble/feishu/。")}`,
        "",
        `${indent}${themeForeground(theme.inputText, "按 Enter 继续绑定第一个 chat，或 Esc 跳过。")}`,
      ].slice(0, budget);
    }
    if (this.stage.kind === "error") {
      return [
        title,
        "",
        ...wrapTextWithAnsi(`❌ ${safeSheetText(this.stage.message)}`, contentWidth)
          .map((line) => `${indent}${themeForeground(theme.error, line)}`),
      ].slice(0, budget);
    }
    return this.renderBinding(title, indent, contentWidth, budget, theme);
  }

  private renderBinding(title: string, indent: string, width: number, budget: number, theme: Theme): string[] {
    if (this.stage.kind !== "binding") return [];
    const stage = this.stage;
    const fields: Array<{ key: keyof BindingValues; label: string; hint: string }> = [
      { key: "chatId", label: "Chat ID", hint: "oc_ 开头；如果还不知道，可按 Esc 跳过后使用 /feishu discover。" },
      { key: "cwd", label: "本地目录", hint: `绝对路径或 ~/…，例如 ${homedir()}/projects/app` },
      { key: "displayName", label: "显示名", hint: "可留空；默认使用目录名。" },
    ];
    const currentIndex = fields.findIndex((field) => field.key === stage.field);
    const rows = [title, ""];
    for (const [index, field] of fields.entries()) {
      const active = index === currentIndex;
      const done = index < currentIndex;
      const marker = active ? "›" : done ? "✓" : " ";
      const value = safeSheetInlineText(stage.values[field.key]);
      rows.push(`${indent}${themeForeground(active ? theme.accent : done ? theme.success : theme.muted, `${marker} ${field.label}: ${value}${active ? "▌" : ""}`)}`);
      if (active) rows.push(`${indent}${themeDim(theme.dim, truncateToWidth(field.hint, width, "…"))}`);
    }
    if (stage.error) {
      rows.push(`${indent}${themeForeground(theme.error, truncateToWidth(stage.error, width, "…"))}`);
    }
    return rows.slice(0, budget);
  }

  private helpText(): string {
    if (this.stage.kind === "credentialed") return "Enter bind first chat  │  Esc skip binding";
    if (this.stage.kind === "binding") return "Enter next  │  Backspace delete  │  Esc skip binding";
    if (this.stage.kind === "error") return "Enter/Space dismiss  │  Esc cancel";
    return "Scan with Feishu mobile  │  Esc cancel";
  }

  private advanceBinding(): void {
    if (this.stage.kind !== "binding") return;
    const value = this.stage.values[this.stage.field].trim();
    if (this.stage.field === "chatId") {
      if (!value) {
        this.stage = { ...this.stage, error: "Chat ID 不能为空。" };
      } else {
        this.stage = { ...this.stage, field: "cwd", error: undefined };
      }
      this.options.onRender();
      return;
    }
    if (this.stage.field === "cwd") {
      const cwd = expandUser(value);
      if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        this.stage = { ...this.stage, error: `路径不存在或不是目录：${cwd}` };
      } else {
        this.stage = {
          ...this.stage,
          field: "displayName",
          values: { ...this.stage.values, cwd, displayName: this.stage.values.displayName || basename(cwd) },
          error: undefined,
        };
      }
      this.options.onRender();
      return;
    }

    const displayName = value || basename(this.stage.values.cwd);
    const scope: ScopeConfig = {
      cwd: this.stage.values.cwd,
      displayName,
      allowedUsers: [this.stage.ownerOpenId],
      admins: [this.stage.ownerOpenId],
      defaultPermissionMode: "default",
      model: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    try {
      if (this.options.saveScope) {
        this.options.saveScope(this.stage.values.chatId.trim(), scope);
      } else {
        ScopeRegistry.load().upsert(this.stage.values.chatId.trim(), scope);
      }
    } catch (error) {
      this.stage = { ...this.stage, error: `保存 scope 失败：${errorMessage(error)}` };
      this.options.onRender();
      return;
    }
    this.finish({
      kind: "completed",
      summary: `✅ Feishu 已注册并绑定第一个 chat：\n  chat: ${this.stage.values.chatId.trim()}\n  cwd:  ${this.stage.values.cwd}\n现在可以运行 /feishu start 启动服务。`,
    });
  }

  private updateBinding(value: string): void {
    if (this.stage.kind !== "binding") return;
    this.stage = {
      ...this.stage,
      values: { ...this.stage.values, [this.stage.field]: value },
      error: undefined,
    };
    this.options.onRender();
  }

  private showError(message: string): void {
    this.stage = { kind: "error", message };
    this.options.onRender();
  }

  private finish(result: FeishuSetupResult): void {
    if (this.settled) return;
    this.settled = true;
    this.abortController.abort();
    this.options.onResult(result);
  }
}

function renderQr(url: string): Promise<string> {
  return new Promise((resolve) => qrTerminal.generate(url, { small: true }, resolve));
}

function registrationStatus(status: string): string {
  if (status === "polling") return "等待扫码…";
  if (status === "slow_down") return "轮询变慢中…仍在等待";
  if (status === "domain_switched") return "已切换域名";
  return safeSheetInlineText(status);
}

function printableInput(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data);
  if (decoded !== undefined) return decoded;
  // eslint-disable-next-line no-control-regex
  return data && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(data) ? data : undefined;
}

function removeLastGrapheme(value: string): string {
  const segments = [...graphemeSegmenter.segment(value)];
  const last = segments[segments.length - 1];
  return last ? value.slice(0, last.index) : "";
}

function expandUser(value: string): string {
  if (value === "~" || value.startsWith("~/")) return homedir() + value.slice(1);
  return resolvePath(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
