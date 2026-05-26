/** @jsxImportSource @opentui/react */
import React, { useEffect, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import qrTerminal from "qrcode-terminal";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, basename } from "node:path";
import { homedir } from "node:os";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { useTheme } from "./theme.js";
import { bootstrapConfig } from "../feishu/config.js";
import { ScopeRegistry } from "../feishu/scope/scope-registry.js";
import type { ScopeConfig } from "../feishu/types.js";

export interface FeishuSetupPickerProps {
  onComplete: (summary: string) => void;
  onCancel: () => void;
}

type Stage =
  | { kind: "registering" }
  | { kind: "qr_shown"; url: string; ascii: string; status: string }
  | { kind: "credentialed"; ownerOpenId: string; configWritten: boolean }
  | { kind: "binding"; ownerOpenId: string; field: "chatId" | "cwd" | "displayName"; values: BindingValues; error?: string }
  | { kind: "done"; summary: string }
  | { kind: "error"; message: string };

interface BindingValues {
  chatId: string;
  cwd: string;
  displayName: string;
}

const EMPTY_VALUES: BindingValues = { chatId: "", cwd: "", displayName: "" };

export function FeishuSetupPicker({ onComplete, onCancel }: FeishuSetupPickerProps) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>({ kind: "registering" });
  const abortRef = useRef<AbortController | undefined>(undefined);
  const completedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    let cancelled = false;
    void (async () => {
      try {
        const result = await registerApp({
          signal: controller.signal,
          onQRCodeReady: (info) => {
            if (cancelled) return;
            qrTerminal.generate(info.url, { small: true }, (ascii: string) => {
              if (cancelled) return;
              setStage({
                kind: "qr_shown",
                url: info.url,
                ascii,
                status: "等待扫码…",
              });
            });
          },
          onStatusChange: (info) => {
            if (cancelled) return;
            setStage((prev) => {
              if (prev.kind !== "qr_shown") return prev;
              const label = info.status === "polling"
                ? "等待扫码…"
                : info.status === "slow_down"
                ? "轮询变慢中…仍在等待"
                : info.status === "domain_switched"
                ? "已切换域名"
                : info.status;
              return { ...prev, status: label };
            });
          },
        });
        if (cancelled) return;
        const ownerOpenId = result.user_info?.open_id;
        if (!ownerOpenId) {
          setStage({ kind: "error", message: "授权成功但没拿到 owner open_id，无法继续。" });
          return;
        }
        try {
          bootstrapConfig({
            appId: result.client_id,
            appSecret: result.client_secret,
            ownerOpenId,
          });
        } catch (err) {
          setStage({ kind: "error", message: `保存 config 失败：${(err as Error).message}` });
          return;
        }
        setStage({ kind: "credentialed", ownerOpenId, configWritten: true });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setStage({ kind: "error", message: (err as Error).message || "扫码注册失败" });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const finish = (summary: string) => {
    if (completedRef.current) return;
    completedRef.current = true;
    setStage({ kind: "done", summary });
    onComplete(summary);
  };

  const cancel = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    abortRef.current?.abort();
    onCancel();
  };

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.name === "escape") {
      // Esc at any stage = cancel/skip.
      if (stage.kind === "credentialed") {
        finish(`✅ 应用已注册并保存到 ~/.bubble/feishu/。owner: ${stage.ownerOpenId}\n(已跳过 chat 绑定 — 稍后可以编辑 ~/.bubble/feishu/scopes.json 添加)`);
        return;
      }
      if (stage.kind === "binding") {
        finish(`✅ 应用已注册。owner: ${stage.ownerOpenId}\n(已跳过 chat 绑定 — 稍后可以 /feishu setup 重来或编辑 scopes.json)`);
        return;
      }
      cancel();
      return;
    }

    if (stage.kind === "credentialed" && key.name === "return") {
      setStage({
        kind: "binding",
        ownerOpenId: stage.ownerOpenId,
        field: "chatId",
        values: EMPTY_VALUES,
      });
      return;
    }

    if (stage.kind === "error" && key.name === "return") {
      onCancel();
      return;
    }

    if (stage.kind !== "binding") return;

    const cur = stage;
    const updateValue = (next: string) => {
      setStage({ ...cur, values: { ...cur.values, [cur.field]: next }, error: undefined });
    };

    if (key.name === "return") {
      const submitField = cur.field;
      const value = cur.values[submitField];
      if (submitField === "chatId") {
        if (!value.trim()) {
          setStage({ ...cur, error: "Chat ID 不能为空（oc_...）" });
          return;
        }
        setStage({ ...cur, field: "cwd", error: undefined });
        return;
      }
      if (submitField === "cwd") {
        const expanded = expandUser(value.trim());
        if (!isAbsolute(expanded)) {
          setStage({ ...cur, error: "cwd 必须是绝对路径或 ~/..." });
          return;
        }
        if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
          setStage({ ...cur, error: `路径不存在或不是目录：${expanded}` });
          return;
        }
        // Pre-fill display name with basename if user left it empty later.
        const nextDisplayName = cur.values.displayName || basename(expanded);
        setStage({
          ...cur,
          field: "displayName",
          values: { ...cur.values, cwd: expanded, displayName: nextDisplayName },
          error: undefined,
        });
        return;
      }
      // displayName
      const displayName = value.trim() || basename(cur.values.cwd);
      try {
        const registry = ScopeRegistry.load();
        const scope: ScopeConfig = {
          cwd: cur.values.cwd,
          displayName,
          allowedUsers: [cur.ownerOpenId],
          admins: [cur.ownerOpenId],
          defaultPermissionMode: "default",
          model: null,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        };
        registry.upsert(cur.values.chatId.trim(), scope);
      } catch (err) {
        setStage({ ...cur, error: `保存 scope 失败：${(err as Error).message}` });
        return;
      }
      finish(`✅ 已注册应用并绑定第一个 chat：\n  chat: ${cur.values.chatId.trim()}\n  cwd:  ${cur.values.cwd}\n现在可以 /feishu start 启动服务。`);
      return;
    }

    if (key.name === "backspace" || key.name === "delete") {
      updateValue(cur.values[cur.field].slice(0, -1));
      return;
    }

    if (key.name === "tab" && cur.field === "displayName") {
      // Tab in displayName field = use default (basename).
      updateValue(basename(cur.values.cwd));
      return;
    }

    if (key.name && key.name.length === 1 && !key.ctrl && !key.option) {
      updateValue(cur.values[cur.field] + key.name);
    }
  });

  return (
    <box
      style={{
        flexDirection: "column",
        marginTop: 1,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        border: true,
        borderColor: theme.borderActive,
      }}
    >
      <text fg={theme.accent} attributes={1}>Feishu Setup Wizard</text>
      <text fg={theme.muted}>{renderHint(stage)}</text>
      <box style={{ marginTop: 1, flexDirection: "column" }}>{renderBody(stage, theme)}</box>
    </box>
  );
}

function renderHint(stage: Stage): string {
  switch (stage.kind) {
    case "registering": return "Esc 取消";
    case "qr_shown":    return "用手机飞书扫码 · Esc 取消";
    case "credentialed":return "Enter 绑定第一个 chat · Esc 跳过（之后可手动配置 scopes.json）";
    case "binding":     return "输入后 Enter 下一步 · Esc 跳过绑定";
    case "done":        return "Enter 关闭";
    case "error":       return "Enter 关闭";
  }
}

interface ThemeShape {
  accent: string;
  muted: string;
  borderActive: string;
}

function renderBody(stage: Stage, theme: ThemeShape): React.ReactNode {
  switch (stage.kind) {
    case "registering":
      return <text fg={theme.muted}>正在向飞书申请注册码…</text>;
    case "qr_shown":
      return (
        <box style={{ flexDirection: "column" }}>
          <text fg={theme.muted}>{stage.status}</text>
          <box style={{ marginTop: 1, flexDirection: "column" }}>
            {stage.ascii.split("\n").map((line, i) => (
              <text key={`q-${i}`}>{line || " "}</text>
            ))}
          </box>
          <box style={{ marginTop: 1, flexDirection: "column" }}>
            <text fg={theme.muted}>扫不到？也可以浏览器打开：</text>
            <text>{stage.url}</text>
          </box>
        </box>
      );
    case "credentialed":
      return (
        <box style={{ flexDirection: "column" }}>
          <text fg={theme.accent}>✅ 注册成功</text>
          <box style={{ flexDirection: "row" }}>
            <text>owner open_id: </text>
            <text fg={theme.accent}>{stage.ownerOpenId}</text>
          </box>
          <box style={{ marginTop: 1 }}>
            <text fg={theme.muted}>已写入 ~/.bubble/feishu/config.json + secrets.enc（加密）。</text>
          </box>
          <box style={{ marginTop: 1 }}>
            <text>下一步：把一个飞书 chat 绑定到本地目录？</text>
          </box>
        </box>
      );
    case "binding":
      return <BindingForm stage={stage} theme={theme} />;
    case "done":
      return (
        <box style={{ flexDirection: "column" }}>
          {stage.summary.split("\n").map((line, i) => (
            <text key={i}>{line}</text>
          ))}
        </box>
      );
    case "error":
      return (
        <box style={{ flexDirection: "column" }}>
          <text fg="red">❌ {stage.message}</text>
          <box style={{ marginTop: 1 }}>
            <text fg={theme.muted}>按 Enter 关闭。可以稍后再 /feishu setup 重试。</text>
          </box>
        </box>
      );
  }
}

function BindingForm({ stage, theme }: { stage: Extract<Stage, { kind: "binding" }>; theme: ThemeShape }) {
  const labels: Record<keyof BindingValues, { label: string; hint: string }> = {
    chatId: {
      label: "Chat ID",
      hint: "飞书 chat 的 oc_ 开头 ID。⚠️ 现在你大概率还不知道这个 —— 按 Esc 跳过，先 /feishu start 起服务，给 bot 发条消息后用 /feishu discover 自动获取。",
    },
    cwd: {
      label: "本地 cwd",
      hint: `例如 ${homedir()}/projects/my-app（绝对路径或 ~/...）`,
    },
    displayName: {
      label: "显示名（可空，默认 = 目录名）",
      hint: "出现在飞书卡片顶栏的短标签",
    },
  };
  return (
    <box style={{ flexDirection: "column" }}>
      {(Object.keys(labels) as Array<keyof BindingValues>).map((field) => {
        const meta = labels[field];
        const value = stage.values[field];
        const isActive = stage.field === field;
        const isDone = !isActive && value && fieldOrderIndex(stage.field) > fieldOrderIndex(field);
        const marker = isActive ? "› " : isDone ? "✓ " : "  ";
        return (
          <box key={field} style={{ flexDirection: "column", marginBottom: isActive ? 1 : 0 }}>
            <box style={{ flexDirection: "row" }}>
              <text fg={isActive ? theme.accent : isDone ? "green" : theme.muted}>
                {marker}{meta.label}:
              </text>
              <box style={{ marginLeft: 1 }}>
                <text>{value}{isActive ? "▌" : ""}</text>
              </box>
            </box>
            {isActive && (
              <box style={{ marginLeft: 2 }}>
                <text fg={theme.muted}>{meta.hint}</text>
              </box>
            )}
          </box>
        );
      })}
      {stage.error && (
        <box style={{ marginTop: 1 }}>
          <text fg="red">{stage.error}</text>
        </box>
      )}
    </box>
  );
}

function fieldOrderIndex(field: keyof BindingValues): number {
  return field === "chatId" ? 0 : field === "cwd" ? 1 : 2;
}

function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) return homedir() + p.slice(1);
  return resolvePath(p);
}