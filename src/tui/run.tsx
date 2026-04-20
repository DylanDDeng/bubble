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

export interface RunTuiOptions {
  sessionManager?: SessionManager;
  createProvider?: (providerId: string, apiKey: string, baseURL: string) => Provider;
  registry?: ProviderRegistry;
  skillRegistry?: SkillRegistry;
  planHandlerRef?: PlanHandlerRef;
  approvalHandlerRef?: ApprovalHandlerRef;
  bashAllowlist?: BashAllowlist;
  settingsManager?: SettingsManager;
  bypassEnabled?: boolean;
}

export function runTui(agent: Agent, args: CliArgs, options: RunTuiOptions = {}) {
  render(
    <App
      agent={agent}
      args={args}
      sessionManager={options.sessionManager}
      createProvider={options.createProvider}
      registry={options.registry}
      skillRegistry={options.skillRegistry}
      planHandlerRef={options.planHandlerRef}
      approvalHandlerRef={options.approvalHandlerRef}
      bashAllowlist={options.bashAllowlist}
      settingsManager={options.settingsManager}
      bypassEnabled={options.bypassEnabled}
    />,
  );
}
