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
  grep: "Search file contents using regex",
  ls: "List files in a directory",
  web_search: "Search the public web for current information",
  web_fetch: "Fetch and extract the contents of a specific webpage",
};

export const defaultToolNames = ["read", "bash", "edit", "write", "grep", "ls", "web_search", "web_fetch"];

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
