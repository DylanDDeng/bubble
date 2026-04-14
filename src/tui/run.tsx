import { render } from "ink";
import React from "react";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { Provider } from "../types.js";
import type { ProviderRegistry } from "../provider-registry.js";
import { App } from "./app.js";

export function runTui(
  agent: Agent,
  args: CliArgs,
  sessionManager?: SessionManager,
  createProvider?: (apiKey: string, baseURL: string) => Provider,
  registry?: ProviderRegistry
) {
  render(<App agent={agent} args={args} sessionManager={sessionManager} createProvider={createProvider} registry={registry} />);
}
