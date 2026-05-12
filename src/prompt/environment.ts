import { cwd } from "node:process";

export interface EnvironmentPromptOptions {
  configuredProvider?: string;
  configuredModel?: string;
  configuredModelId?: string;
  workingDir?: string;
  currentDate?: string;
  tools?: string[];
  toolSnippets?: Record<string, string>;
}

export const defaultToolSnippets: Record<string, string> = {
  read: "Read the contents of a file",
  bash: "Execute a bash command",
  edit: "Apply targeted string replacements to a file",
  write: "Write a new file or overwrite an existing one",
  glob: "Find files by glob pattern without using bash",
  grep: "Search file contents using regex",
  lsp: "Use the language server for code navigation, symbols, call hierarchy, and type-aware lookup",
  web_search: "Search the public web for current information",
  web_fetch: "Fetch and extract the contents of a specific webpage",
  spawn_agent: "Start a child subagent thread and return its agent id plus nickname",
  wait_agent: "Wait for one or more spawned subagents to finish",
  send_input: "Send follow-up input to an existing subagent thread",
  close_agent: "Close or cancel a spawned subagent thread",
  question: "Ask the user structured questions when clarification or preference choices would materially improve the work",
  skill: "Load a named skill with specialized instructions and bundled resources",
  todo_write: "Plan and track multi-step work. Mark each task completed as soon as it is done — do not batch.",
};

export const defaultToolNames = [
  "read",
  "glob",
  "bash",
  "edit",
  "write",
  "grep",
  "lsp",
  "web_search",
  "web_fetch",
  "spawn_agent",
  "wait_agent",
  "send_input",
  "close_agent",
  "question",
  "skill",
  "todo_write",
];

export function buildEnvironmentPrompt(options: EnvironmentPromptOptions = {}): string {
  const configuredProvider = options.configuredProvider ?? "unknown";
  const configuredModel = options.configuredModel ?? "unknown";
  const configuredModelId = options.configuredModelId ?? "unknown";
  const workingDir = options.workingDir ?? cwd().replace(/\\/g, "/");
  const currentDate = options.currentDate ?? new Date().toISOString().slice(0, 10);
  const tools = options.tools ?? defaultToolNames;
  const snippets = options.toolSnippets ?? defaultToolSnippets;

  const visibleTools = tools.filter((name) => snippets[name]);
  const toolList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
    : "(none)";

  return `Configured provider: ${configuredProvider}
Configured model: ${configuredModel}
Configured model id: ${configuredModelId}

Available tools:
${toolList}

Current date: ${currentDate}
Current working directory: ${workingDir}`;
}
