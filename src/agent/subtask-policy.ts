import type { ToolRegistryEntry, ToolResultStatus } from "../types.js";

export type SubtaskType =
  | "search"
  | "security_investigation"
  | "evidence_correlation"
  | "general_readonly";

export interface SubtaskPolicy {
  type: SubtaskType;
  allowedTools: string[];
  reminder: string;
  resultStatus: ToolResultStatus;
  maxTurns?: number;
  taskBudget?: { total: number };
}

const POLICY_MAP: Record<SubtaskType, SubtaskPolicy> = {
  search: {
    type: "search",
    allowedTools: ["read", "glob", "grep", "web_search", "web_fetch", "skill", "todo_write"],
    reminder: [
      "Subtask policy: search",
      "- Focus on locating relevant files, symbols, and evidence quickly.",
      "- Use glob for file discovery and grep for content search.",
      "- Return a concise summary of what you found and where.",
    ].join("\n"),
    resultStatus: "success",
    maxTurns: 6,
    taskBudget: { total: 180_000 },
  },
  security_investigation: {
    type: "security_investigation",
    allowedTools: ["read", "glob", "grep", "web_search", "web_fetch", "skill", "todo_write"],
    reminder: [
      "Subtask policy: security_investigation",
      "- Investigate only in read-only mode.",
      "- Collect evidence about config load paths, environment reads, persistence paths, masking, and exposure paths.",
      "- Do not loop on broad keyword search; summarize evidence and uncertainty.",
    ].join("\n"),
    resultStatus: "success",
    maxTurns: 8,
    taskBudget: { total: 220_000 },
  },
  evidence_correlation: {
    type: "evidence_correlation",
    allowedTools: ["read", "skill", "todo_write"],
    reminder: [
      "Subtask policy: evidence_correlation",
      "- Correlate evidence already discovered.",
      "- Avoid new broad searches; read only the specific files that matter.",
      "- Produce a reasoning-focused summary that states what the evidence supports.",
    ].join("\n"),
    resultStatus: "success",
    maxTurns: 4,
    taskBudget: { total: 120_000 },
  },
  general_readonly: {
    type: "general_readonly",
    allowedTools: ["read", "glob", "grep", "web_search", "web_fetch", "skill", "todo_write"],
    reminder: [
      "Subtask policy: general_readonly",
      "- Stay in read-only mode.",
      "- Keep the scope tightly bounded and summarize findings concisely.",
    ].join("\n"),
    resultStatus: "success",
    maxTurns: 6,
    taskBudget: { total: 180_000 },
  },
};

export function getSubtaskPolicy(type: SubtaskType | undefined): SubtaskPolicy {
  return POLICY_MAP[type ?? "general_readonly"];
}

export function filterToolsForSubtask(tools: ToolRegistryEntry[], type: SubtaskType | undefined): ToolRegistryEntry[] {
  const policy = getSubtaskPolicy(type);
  return tools.filter((tool) => policy.allowedTools.includes(tool.name));
}
