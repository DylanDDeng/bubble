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
  web_search: "Search the public web for current information",
  web_fetch: "Fetch and extract the contents of a specific webpage",
  task: "Delegate a bounded investigative subtask to a read-only sub-agent",
  skill: "Load a named skill with specialized instructions and bundled resources",
};

export const defaultToolNames = ["read", "glob", "bash", "edit", "write", "grep", "web_search", "web_fetch", "task", "skill"];

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
