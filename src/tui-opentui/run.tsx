/** @jsxImportSource @opentui/react */

/**
 * OpenTUI entry point. Mirrors the Ink `runTui` API so main.ts can swap
 * between renderers via an env flag without changing any call sites.
 */

import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import chalk from "chalk";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { App, type ApprovalHandlerRef, type ExitSummary, type PlanHandlerRef } from "./app.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspService } from "../lsp/index.js";
import type { QuestionController } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";
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
  lspService?: LspService;
  mcpManager?: McpManager;
  themeMode?: ThemeMode;
  themeOverrides?: Record<string, string>;
  detectedTheme?: ResolvedTheme;
  onThemeModeChange?: (mode: ThemeMode) => void;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
  bypassEnabled?: boolean;
}

export async function runTui(agent: Agent, args: CliArgs, options: RunTuiOptions = {}) {
  let exitSummary: ExitSummary | undefined;
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);
  root.render(
    <App
      agent={agent}
      args={args}
      sessionManager={options.sessionManager}
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
      themeMode={options.themeMode}
      themeOverrides={options.themeOverrides}
      detectedTheme={options.detectedTheme}
      onThemeModeChange={options.onThemeModeChange}
      flushMemory={options.flushMemory}
      runMemoryCompaction={options.runMemoryCompaction}
      runMemorySummary={options.runMemorySummary}
      runMemoryRefresh={options.runMemoryRefresh}
      bypassEnabled={options.bypassEnabled}
      onExit={(summary) => {
        exitSummary = summary;
      }}
    />,
  );

  await new Promise<void>((resolve) => {
    // OpenTUI emits "destroyed" when renderer.destroy() lands. Listen once.
    const onDone = () => {
      try {
        root.unmount();
      } catch {
        // ignore — root may already be torn down
      }
      resolve();
    };
    renderer.on?.("destroyed", onDone) ?? renderer.once?.("destroyed", onDone);
  });

  if (process.stdout.isTTY) {
    process.stdout.write("\n");
    if (exitSummary) {
      process.stdout.write(formatExitSummary(exitSummary) + "\n");
    }
  }
}

function formatExitSummary(summary: ExitSummary): string {
  const label = "Total duration:";
  return chalk.dim(`${label} ${formatWallMs(summary.wallMs)}`);
}

function formatWallMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const minutesRest = minutes % 60;
  return `${hours}h ${minutesRest}m ${seconds}s`;
}
