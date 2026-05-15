import { render } from "ink";
import React from "react";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { App, type ApprovalHandlerRef, type PlanHandlerRef } from "./app.js";
import type { BashAllowlist } from "../approval/session-cache.js";
import type { SettingsManager } from "../permissions/settings.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspService } from "../lsp/index.js";
import type { QuestionController } from "../question/index.js";
import type { MemoryScope } from "../memory/index.js";

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
  theme?: Record<string, string>;
  flushMemory?: () => Promise<void>;
  runMemoryCompaction?: () => Promise<string>;
  runMemorySummary?: (scope?: MemoryScope) => Promise<string>;
  runMemoryRefresh?: (scope?: MemoryScope) => Promise<string>;
  bypassEnabled?: boolean;
}

export async function runTui(agent: Agent, args: CliArgs, options: RunTuiOptions = {}) {
  const instance = render(
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
      flushMemory={options.flushMemory}
      runMemoryCompaction={options.runMemoryCompaction}
      runMemorySummary={options.runMemorySummary}
      runMemoryRefresh={options.runMemoryRefresh}
      bypassEnabled={options.bypassEnabled}
      onExit={() => {
        // The app already called useApp().exit() inside requestExit, which
        // triggers Ink's own unmount + TTY restore. waitUntilExit() below is
        // the canonical signal that we're done — we deliberately do *not*
        // call instance.unmount() again here to avoid double-teardown
        // warnings on React 19.
      }}
    />,
  );
  await instance.waitUntilExit();
  // zsh's PROMPT_SP prints a reverse-video `%` if the previous program left
  // the cursor mid-line. Ink's interactive teardown (log-update.done) doesn't
  // emit a trailing newline, so mirror Ink's non-interactive branch and align
  // the cursor to column 0 before handing control back to the shell.
  if (process.stdout.isTTY) {
    process.stdout.write("\n");
  }
}
