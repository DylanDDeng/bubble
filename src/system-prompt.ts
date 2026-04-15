/**
 * System prompt construction.
 */

import { cwd } from "node:process";

export interface SystemPromptOptions {
  /** Agent display name */
  agentName?: string;
  /** Configured provider id */
  configuredProvider?: string;
  /** Configured model name */
  configuredModel?: string;
  /** Full configured model id */
  configuredModelId?: string;
  /** Names of available tools */
  tools?: string[];
  /** One-line description for each tool */
  toolSnippets?: Record<string, string>;
  /** Extra guidelines */
  guidelines?: string[];
  /** Working directory to include in prompt */
  workingDir?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
  const date = new Date().toISOString().slice(0, 10);
  const agentName = options.agentName ?? "Bubble";
  const configuredProvider = options.configuredProvider;
  const configuredModel = options.configuredModel;
  const configuredModelId = options.configuredModelId;
  const workingDir = options.workingDir ?? cwd().replace(/\\/g, "/");
  const tools = options.tools ?? ["read", "bash", "edit", "write", "grep", "ls"];
  const snippets = options.toolSnippets ?? defaultToolSnippets;

  const visibleTools = tools.filter((name) => snippets[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
    : "(none)";

  const guidelines: string[] = [];
  const add = (g: string) => {
    if (!guidelines.includes(g)) guidelines.push(g);
  };

  if (tools.includes("bash") && tools.some((t) => ["grep", "ls"].includes(t))) {
    add("Prefer grep/ls over bash for file exploration (faster, respects .gitignore)");
  }

  add("Before editing or writing files, read them first if they exist");
  add("Use edit for targeted changes to existing files; use write for creating new files");
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");

  for (const g of options.guidelines ?? []) {
    if (!guidelines.includes(g)) guidelines.push(g);
  }

  const guidelinesText = guidelines.map((g) => `- ${g}`).join("\n");

  return `You are ${agentName}, an expert coding assistant operating in a terminal environment. You help users by reading files, executing commands, editing code, and writing new files.

Configured model: ${configuredModel ?? "unknown"}
Configured provider: ${configuredProvider ?? "unknown"}
Configured model id: ${configuredModelId ?? "unknown"}

Available tools:
${toolsList}

Guidelines:
${guidelinesText}

Current date: ${date}
Current working directory: ${workingDir}`;
}

const defaultToolSnippets: Record<string, string> = {
  read: "Read the contents of a file",
  bash: "Execute a bash command",
  edit: "Apply targeted string replacements to a file",
  write: "Write a new file or overwrite an existing one",
  grep: "Search file contents using regex",
  ls: "List files in a directory",
};
