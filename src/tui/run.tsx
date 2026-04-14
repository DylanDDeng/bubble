import { render } from "ink";
import React from "react";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import { App } from "./app.js";

export function runTui(agent: Agent, args: CliArgs, sessionManager?: SessionManager) {
  render(<App agent={agent} args={args} sessionManager={sessionManager} />);
}
