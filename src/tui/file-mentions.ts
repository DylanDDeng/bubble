import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_INLINE_BYTES = 200 * 1024;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache"]);

export interface AtContext {
  start: number;
  end: number;
  query: string;
}

export interface FileSuggestion {
  path: string;
  score: number;
}

export interface ExpandedMention {
  path: string;
  bytes: number;
  truncated: boolean;
}

export interface ExpandResult {
  text: string;
  expanded: ExpandedMention[];
  missing: string[];
  skipped: Array<{ path: string; reason: string; bytes?: number }>;
}

const fileListCache = new Map<string, string[]>();

export function findAtContext(text: string, cursor: number): AtContext | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prev = at === 0 ? "" : before[at - 1];
  if (prev !== "" && !/\s/.test(prev)) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, end: cursor, query };
}

export function filterFileSuggestions(files: string[], query: string, limit = 20): FileSuggestion[] {
  const q = query.toLowerCase();
  if (q.length === 0) {
    return files.slice(0, limit).map((p) => ({ path: p, score: 1 }));
  }
  const scored: FileSuggestion[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const base = path.basename(lower);
    let score = 0;
    if (base.startsWith(q)) score = 100;
    else if (lower.startsWith(q)) score = 80;
    else if (base.includes(q)) score = 60;
    else if (lower.includes(q)) score = 40;
    if (score > 0) scored.push({ path: file, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length) || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

export async function listProjectFiles(cwd: string): Promise<string[]> {
  const cached = fileListCache.get(cwd);
  if (cached) return cached;
  const files = await discoverFiles(cwd);
  fileListCache.set(cwd, files);
  return files;
}

export function invalidateFileListCache(cwd?: string) {
  if (cwd) fileListCache.delete(cwd);
  else fileListCache.clear();
}

async function discoverFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    const files = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Not a git repo or git unavailable — fall through to filesystem walk.
  }
  return walkFilesystem(cwd);
}

async function walkFilesystem(root: string): Promise<string[]> {
  const results: string[] = [];
  async function visit(dir: string, rel: string) {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(abs, relPath);
      } else if (entry.isFile()) {
        results.push(relPath);
      }
    }
  }
  await visit(root, "");
  return results;
}

const MENTION_REGEX = /(^|\s)@([^\s]+)/g;

export async function expandAtMentions(text: string, cwd: string): Promise<ExpandResult> {
  const result: ExpandResult = { text, expanded: [], missing: [], skipped: [] };
  const mentions = Array.from(text.matchAll(MENTION_REGEX));
  if (mentions.length === 0) return result;

  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of mentions) {
    const token = match[2];
    if (seen.has(token)) continue;
    seen.add(token);
    const abs = path.resolve(cwd, token);
    if (!abs.startsWith(path.resolve(cwd))) {
      result.skipped.push({ path: token, reason: "outside project" });
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      result.missing.push(token);
      continue;
    }
    if (!stat.isFile()) {
      result.skipped.push({ path: token, reason: "not a file" });
      continue;
    }
    if (stat.size > MAX_INLINE_BYTES) {
      result.skipped.push({ path: token, reason: "too large", bytes: stat.size });
      blocks.push(`### @${token}\n(${formatBytes(stat.size)}, exceeds inline limit of ${formatBytes(MAX_INLINE_BYTES)} — use the Read tool to access)`);
      continue;
    }
    let contents: string;
    try {
      contents = await fs.readFile(abs, "utf8");
    } catch (err: any) {
      result.skipped.push({ path: token, reason: `read failed: ${err.message || String(err)}` });
      continue;
    }
    result.expanded.push({ path: token, bytes: stat.size, truncated: false });
    const lang = guessLanguage(token);
    blocks.push(`### @${token}\n\`\`\`${lang}\n${contents}\n\`\`\``);
  }

  if (blocks.length === 0) return result;
  result.text = `${text}\n\n---\nReferenced files:\n\n${blocks.join("\n\n")}`;
  return result;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function guessLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", zsh: "bash", bash: "bash",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
    html: "html", css: "css", scss: "scss", sql: "sql", md: "markdown",
  };
  return map[ext] ?? "";
}
