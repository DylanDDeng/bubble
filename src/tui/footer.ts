/** Shared footer line renderer (main + fullscreen modes). */
import chalk from "chalk";
import { formatContextUsageLabel, friendlyCwd } from "./formatting/summary.js";

export interface FooterAgentInfo {
  model: string;
  getContextUsageSnapshot(): { usedTokens: number; contextWindow?: number };
}

export function renderFooterLine(agent: FooterAgentInfo, columns: number): string {
  const usage = formatContextUsageLabel(agent.getContextUsageSnapshot());
  const cwd = friendlyCwd(process.cwd());
  const line = [chalk.cyan(agent.model), chalk.dim(cwd), chalk.dim(usage)].join(chalk.dim(" │ "));
  return line.length > columns ? line.slice(0, columns) : line;
}
