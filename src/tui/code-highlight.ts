/**
 * Lightweight code highlighting for TUI using Shiki.
 * Converts token colors to ANSI escape codes for Ink rendering.
 */

import { createHighlighter } from "shiki";

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark"],
      langs: [
        "bash",
        "css",
        "diff",
        "dockerfile",
        "go",
        "html",
        "ini",
        "javascript",
        "json",
        "jsx",
        "markdown",
        "python",
        "rust",
        "shell",
        "sql",
        "typescript",
        "tsx",
        "yaml",
      ],
    });
  }
  return highlighterPromise;
}

function hexToAnsiFg(hex?: string): string {
  if (!hex) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function tokensToAnsi(tokens: Array<Array<{ content: string; color?: string }>>): string {
  const lines: string[] = [];
  for (const line of tokens) {
    let lineStr = "";
    for (const token of line) {
      lineStr += hexToAnsiFg(token.color) + token.content;
    }
    lineStr += "\x1b[0m";
    lines.push(lineStr);
  }
  return lines.join("\n");
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const h = await getHighlighter();
  const loaded = h.getLoadedLanguages();
  const safeLang = loaded.includes(lang as any) ? lang : "text";
  const { tokens } = h.codeToTokens(code, { lang: safeLang as any, theme: "github-dark" });
  return tokensToAnsi(tokens);
}

const LANG_MAP: Record<string, string> = {
  bash: "bash",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  html: "html",
  htm: "html",
  ini: "ini",
  cfg: "ini",
  toml: "ini",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "shell",
  sql: "sql",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function inferLang(path?: string): string {
  if (!path) return "text";
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && LANG_MAP[ext]) || "text";
}
