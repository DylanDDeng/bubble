import { render } from "ink";
import React from "react";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { App, type ApprovalHandlerRef, type ExitSummary, type PlanHandlerRef } from "./app.js";
import {
  ALTERNATE_SCROLL_DISABLE,
  MOUSE_REPORTING_DISABLE,
  MOUSE_REPORTING_ENABLE,
} from "./terminal-mouse.js";
import { warmHighlighter } from "./code-highlight.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspService } from "../lsp/index.js";
import type { QuestionController } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
import type { ExternalHookController } from "../hooks/controller.js";
import type { ResolvedTheme, ThemeMode } from "./theme.js";

export interface RunTuiOptions {
  sessionManager?: SessionManager;
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => Provider;
  registry?: ProviderRegistry;
  skillRegistry?: SkillRegistry;
  planHandlerRef?: PlanHandlerRef;
  approvalHandlerRef?: ApprovalHandlerRef;
  questionController?: QuestionController;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  switchSession?: (sessionFile: string) => { manager: SessionManager } | { error: string };
  lspService?: LspService;
  mcpManager?: McpManager;
  /** Shared with the model-facing goal tools and the Ink auto-continuation loop. */
  goalStore?: import("../goal/store.js").GoalStore;
  themeMode?: ThemeMode;
  themeOverrides?: Record<string, string>;
  detectedTheme?: ResolvedTheme;
  onThemeModeChange?: (mode: ThemeMode) => void;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
  bypassEnabled?: boolean;
  /** One-line "update available" notice rendered under the welcome banner version. */
  updateNotice?: string;
  /** Late update notice refresh surfaced after startup without restarting Ink. */
  updateNoticeRefresh?: Promise<string | null>;
  /** External lifecycle hooks, threaded into slash-command execution. */
  hookController?: ExternalHookController;
}

export function createInkAppElement(
  agent: Agent,
  args: CliArgs,
  options: RunTuiOptions,
  onExit: (summary: ExitSummary) => void,
): React.ReactElement {
  return (
    <App
      agent={agent}
      args={args}
      sessionManager={options.sessionManager}
      switchSession={options.switchSession}
      createProvider={options.createProvider}
      registry={options.registry}
      skillRegistry={options.skillRegistry}
      planHandlerRef={options.planHandlerRef}
      approvalHandlerRef={options.approvalHandlerRef}
      questionController={options.questionController}
      bashAllowlist={options.bashAllowlist}
      settingsManager={options.settingsManager}
      lspService={options.lspService}
      mcpManager={options.mcpManager}
      goalStore={options.goalStore}
      themeMode={options.themeMode}
      themeOverrides={options.themeOverrides}
      detectedTheme={options.detectedTheme}
      onThemeModeChange={options.onThemeModeChange}
      flushMemory={options.flushMemory}
      runMemoryCompaction={options.runMemoryCompaction}
      runMemorySummary={options.runMemorySummary}
      runMemoryRefresh={options.runMemoryRefresh}
      bypassEnabled={options.bypassEnabled}
      updateNotice={options.updateNotice}
      updateNoticeRefresh={options.updateNoticeRefresh}
      hookController={options.hookController}
      onExit={onExit}
    />
  );
}

/**
 * Best-effort terminal restore for abnormal exits. DECSET mouse modes are
 * global terminal state — if the process dies without disabling them, the
 * user's shell receives \x1b[<35;… garbage on every mouse move. The alt-screen
 * and cursor writes are defensive duplicates of Ink's own teardown (idempotent
 * when Ink already ran; load-bearing when it didn't).
 */
function restoreTerminal() {
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(
      ALTERNATE_SCROLL_DISABLE + MOUSE_REPORTING_DISABLE + "\x1b[?1049l\x1b[?25h",
    );
  } catch {
    // stdout may already be destroyed during shutdown
  }
}

export async function runTui(
  agent: Agent,
  args: CliArgs,
  options: RunTuiOptions = {},
): Promise<ExitSummary | undefined> {
  // Kick off shiki load before the first code block is rendered. Fire and
  // forget — CodeBlock's lazy init falls back to raw lines if this isn't ready
  // yet, so callers don't need to await it.
  warmHighlighter();
  let exitSummary: ExitSummary | undefined;
  const onFatalError = (err: unknown) => {
    restoreTerminal();
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    try {
      process.stderr.write(`${detail}\n`);
    } catch {
      // nothing left to report to
    }
    process.exit(1);
  };
  const onSigterm = () => {
    restoreTerminal();
    process.exit(143);
  };
  process.on("uncaughtException", onFatalError);
  process.on("SIGTERM", onSigterm);
  const instance = render(
    createInkAppElement(agent, args, options, (summary) => {
      // The app already called useApp().exit() inside requestExit, which
      // triggers Ink's own unmount + TTY restore. waitUntilExit() below is
      // the canonical signal that we're done — we deliberately do *not*
      // call instance.unmount() again here to avoid double-teardown
      // warnings on React 19. We capture the summary and render it after
      // teardown so it lands in the real shell scrollback (Claude-Code style).
      exitSummary = summary;
    }),
    {
      // Bubble owns Ctrl+C so it can route both raw ETX and kitty keyboard
      // Ctrl+C through App.requestExit(). Ink's default only exits reliably
      // for raw "\x03"; with kitty keyboard it can swallow the parsed
      // ctrl+c event before our useInput handlers see it.
      exitOnCtrlC: false,
      kittyKeyboard: {
        mode: "enabled",
        // reportEventTypes keeps release events out of text input.
        flags: ["disambiguateEscapeCodes", "reportEventTypes"],
      },
      // The whole point of the Ink migration: render into the 1049 alternate
      // screen so streaming repaints never touch the user's shell scrollback.
      // Ink degrades this to false automatically when stdout is not a TTY.
      alternateScreen: true,
    },
  );
  // Keep alternate-scroll disabled so wheel events do not alias keyboard
  // arrows. Enable SGR mouse reporting after alt-screen entry so wheel events
  // scroll the transcript through a distinct input channel.
  if (process.stdout.isTTY) {
    process.stdout.write(ALTERNATE_SCROLL_DISABLE + MOUSE_REPORTING_ENABLE);
  }
  try {
    await instance.waitUntilExit();
  } finally {
    // Reset mouse reporting before anything is printed to the primary screen;
    // Ink has already left the alt screen by the time waitUntilExit() resolves.
    if (process.stdout.isTTY) {
      process.stdout.write(ALTERNATE_SCROLL_DISABLE + MOUSE_REPORTING_DISABLE);
    }
    process.off("uncaughtException", onFatalError);
    process.off("SIGTERM", onSigterm);
  }
  // zsh's PROMPT_SP prints a reverse-video `%` if the previous program left
  // the cursor mid-line. Ink's interactive teardown (log-update.done) doesn't
  // emit a trailing newline, so mirror Ink's non-interactive branch and align
  // the cursor to column 0 before handing control back to the shell.
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
  // The exit summary is printed by main.ts (single print site, after the alt
  // screen has been left, so it lands in the real shell scrollback).
  return exitSummary;
}
