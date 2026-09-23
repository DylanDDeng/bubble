import type { CanonicalToolKind, ToolStatus } from '../types';
import {
  classifyComputerUseAction,
  formatComputerUseLabel,
  parseMcpToolName,
} from '../../shared/computer-use';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(
      value,
      (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
      space
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function getStringField(input: unknown, key: string): string | null {
  if (!isRecord(input)) return null;
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function getProviderDisplayTitle(input: unknown): string | null {
  return (
    getStringField(input, '__aegisDisplayTitle') ||
    getStringField(input, 'displayTitle') ||
    getStringField(input, 'toolTitle')
  );
}

export function getToolSummary(name: string, input: unknown): string {
  const providerTitle = getProviderDisplayTitle(input);
  if (providerTitle) {
    return providerTitle;
  }

  switch (name.trim().toLowerCase()) {
    case 'Bash':
    case 'bash':
      return getStringField(input, 'command') || getStringField(input, 'cmd') || '';
    case 'read':
    case 'read_image':
    case 'write':
    case 'edit':
    case 'delete':
      return (
        getStringField(input, 'file_path') ||
        getStringField(input, 'path') ||
        getStringField(input, 'filename') ||
        ''
      );
    case 'ls':
      return getStringField(input, 'path') || '.';
    case 'glob':
    case 'grep':
      return getStringField(input, 'pattern') || '';
    case 'askuserquestion':
    case 'question': {
      if (!isRecord(input)) return '';
      const questions = input.questions;
      if (!Array.isArray(questions) || questions.length === 0) return '';
      const first = questions[0];
      if (!isRecord(first)) return '';
      return getStringField(first, 'question') || '';
    }
    case 'task': {
      const desc = getStringField(input, 'description');
      if (desc) return desc;
      const prompt = getStringField(input, 'prompt');
      return prompt ? prompt.slice(0, 50) : '';
    }
    case 'image_gen':
    case 'image_edit':
    case 'image_to_video':
    case 'reference_to_video':
    case 'imagine':
    case 'imagine-video':
      return getStringField(input, 'prompt') || '';
    default: {
      const json = safeJsonStringify(input);
      return json.length > 80 ? json.slice(0, 80) : json;
    }
  }
}

// ── Readable display ────────────────────────────────────────────────────────
// Humanized "verb + target" rendering for tool calls. Verb conjugates with
// status so the live spinner reads "Reading file.ts" while the completed entry
// reads "Read file.ts". Inspired by Synara's deriveReadableCommandDisplay.

export interface ReadableToolDisplay {
  verb: string;
  target: string;
}

type VerbPair = readonly [present: string, past: string];

const TOOL_VERBS: Record<string, VerbPair> = {
  Read: ['Reading', 'Read'],
  Write: ['Writing', 'Wrote'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  Delete: ['Deleting', 'Deleted'],
  Glob: ['Finding', 'Found'],
  Grep: ['Searching', 'Searched'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching', 'Searched'],
  Task: ['Running', 'Ran'],
  TodoWrite: ['Updating', 'Updated'],
  NotebookEdit: ['Editing', 'Edited'],
  read: ['Reading', 'Read'],
  read_image: ['Reading image', 'Read image'],
  write: ['Writing', 'Wrote'],
  edit: ['Editing', 'Edited'],
  delete: ['Deleting', 'Deleted'],
  glob: ['Finding', 'Found'],
  grep: ['Searching', 'Searched'],
  web_fetch: ['Fetching', 'Fetched'],
  web_search: ['Searching', 'Searched'],
  task: ['Running', 'Ran'],
  todo_write: ['Updating', 'Updated'],
  image_gen: ['Generating', 'Generated'],
  image_edit: ['Editing', 'Edited'],
  image_to_video: ['Animating', 'Animated'],
  reference_to_video: ['Animating', 'Animated'],
  imagine: ['Generating', 'Generated'],
  'imagine-video': ['Animating', 'Animated'],
};

const SHELL_TOOL_VERBS: Record<string, VerbPair> = {
  cat: ['Reading', 'Read'],
  head: ['Reading', 'Read'],
  tail: ['Reading', 'Read'],
  less: ['Reading', 'Read'],
  more: ['Reading', 'Read'],
  bat: ['Reading', 'Read'],
  ls: ['Listing', 'Listed'],
  tree: ['Listing', 'Listed'],
  grep: ['Searching', 'Searched'],
  rg: ['Searching', 'Searched'],
  ag: ['Searching', 'Searched'],
  find: ['Finding', 'Found'],
  fd: ['Finding', 'Found'],
  rm: ['Removing', 'Removed'],
  mkdir: ['Creating', 'Created'],
  touch: ['Creating', 'Created'],
  cp: ['Copying', 'Copied'],
  mv: ['Moving', 'Moved'],
  curl: ['Fetching', 'Fetched'],
  wget: ['Fetching', 'Fetched'],
};

const GIT_VERBS: Record<string, VerbPair> = {
  status: ['Checking', 'Checked'],
  diff: ['Diffing', 'Diffed'],
  log: ['Reading', 'Read'],
  show: ['Reading', 'Read'],
  add: ['Staging', 'Staged'],
  commit: ['Committing', 'Committed'],
  push: ['Pushing', 'Pushed'],
  pull: ['Pulling', 'Pulled'],
  fetch: ['Fetching', 'Fetched'],
  checkout: ['Switching', 'Switched'],
  switch: ['Switching', 'Switched'],
  branch: ['Listing', 'Listed'],
  merge: ['Merging', 'Merged'],
  rebase: ['Rebasing', 'Rebased'],
  reset: ['Resetting', 'Reset'],
  stash: ['Stashing', 'Stashed'],
  restore: ['Restoring', 'Restored'],
  blame: ['Reading', 'Read'],
};

const DEFAULT_VERB: VerbPair = ['Running', 'Ran'];

function pickVerb(pair: VerbPair, status: ToolStatus): string {
  return status === 'pending' ? pair[0] : pair[1];
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function lastPathSegment(path: string): string {
  const cleaned = path.replace(/^['"]|['"]$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

const SHELL_WRAPPER_RE = /^(?:(?:[\w.-]+\/)+)?(?:bash|sh|zsh|fish|dash)\s+(?:-l\s+)?-l?c\s+(['"])([\s\S]*)\1\s*$/;

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(SHELL_WRAPPER_RE);
  if (match) {
    return match[2].trim();
  }
  return trimmed;
}

function splitFirstToken(command: string): { head: string; rest: string } {
  const trimmed = command.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { head: '', rest: '' };
  return { head: match[1], rest: (match[2] || '').trim() };
}

function firstNonFlagToken(args: string): string | null {
  const tokens = args.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!token.startsWith('-')) {
      return token.replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

const HEREDOC_PREVIEW_CHARS = 200;

/**
 * Split a shell script into statements on `&&`, `||`, `;`, `&` and newlines,
 * ignoring separators inside quotes, `$(...)` and heredoc bodies. Pipeline
 * stages stay inside their statement (`grep x | head` is one unit of work),
 * so each statement is returned as its first stage, whitespace-collapsed.
 */
function splitShellStatements(script: string): string[] {
  const statements: string[] = [];
  // `owner` is the statement whose first stage opened the heredoc, or -1.
  const pendingHeredocs: Array<{ delimiter: string; owner: number }> = [];
  let current = '';
  let stageEnd = -1;
  let quote: string | null = null;
  let depth = 0;

  const push = () => {
    const lead = (stageEnd >= 0 ? current.slice(0, stageEnd) : current).replace(/\s+/g, ' ').trim();
    if (lead) statements.push(lead);
    current = '';
    stageEnd = -1;
  };

  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    const next = script[i + 1];

    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && next !== undefined) {
        current += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '\\' && next !== undefined) {
      current += next === '\n' ? ' ' : ch + next;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '#' && (current === '' || /\s/.test(current[current.length - 1]))) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i += 1;
      continue;
    }
    // `<<` opens a heredoc; `<<<` is a here-string and has no body.
    if (ch === '<' && next === '<' && script[i + 2] !== '<' && script[i - 1] !== '<' && depth === 0) {
      const match = script.slice(i + 2).match(/^-?\s*\\?(['"]?)([\w.-]+)\1/);
      if (match) pendingHeredocs.push({ delimiter: match[2], owner: stageEnd < 0 ? statements.length : -1 });
    }

    if (ch === '\n') {
      if (depth === 0) push();
      else current += ' ';
      // Heredoc bodies are never statements of their own. A short prefix is
      // kept on the statement that opened them, so a `python3 - <<EOF` title
      // still hints at the script.
      while (pendingHeredocs.length > 0) {
        const { delimiter, owner } = pendingHeredocs.shift()!;
        while (i < script.length) {
          const lineEnd = script.indexOf('\n', i + 1);
          const line = script.slice(i + 1, lineEnd === -1 ? script.length : lineEnd);
          i = lineEnd === -1 ? script.length : lineEnd;
          if (line.trim() === delimiter) break;
          if (owner >= 0 && owner < statements.length && statements[owner].length < HEREDOC_PREVIEW_CHARS) {
            statements[owner] = `${statements[owner]} ${line.replace(/\s+/g, ' ').trim()}`.trim();
          }
        }
      }
      continue;
    }

    if (ch === '(') depth += 1;
    if (ch === ')' && depth > 0) depth -= 1;
    if (depth > 0 || ch === ')') {
      current += ch;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push();
      i += 1;
      continue;
    }
    if (ch === ';') {
      push();
      continue;
    }
    if (ch === '&') {
      const prev = current[current.length - 1];
      // `2>&1`, `>&2` and `&>` are redirections, not background separators.
      if (prev === '>' || prev === '<' || next === '>') {
        current += ch;
      } else {
        push();
      }
      continue;
    }
    if (ch === '|') {
      if (stageEnd < 0) stageEnd = current.length;
      current += ch;
      if (next === '&') {
        current += next;
        i += 1;
      }
      continue;
    }
    current += ch;
  }
  push();
  return statements;
}

const SHELL_CONTROL_KEYWORD_RE = /^(?:do|then|else|done|fi|esac|\{|\}|!)(?=\s|$)\s*/;

function stripControlKeywords(statement: string): string {
  let value = statement;
  let match = value.match(SHELL_CONTROL_KEYWORD_RE);
  while (match) {
    value = value.slice(match[0].length);
    match = value.match(SHELL_CONTROL_KEYWORD_RE);
  }
  return value;
}

/** Shell setup that changes context but does no work worth titling a row. */
const SHELL_SETUP_COMMANDS = new Set([
  'cd', 'pushd', 'popd', 'export', 'set', 'unset', 'source', '.', 'shopt',
  'trap', 'ulimit', 'umask', 'local', 'declare', 'readonly',
  'break', 'continue', 'true', ':',
]);

// One `NAME=value` word. Matched word by word from a loop: a single
// `(?:...)+` pattern backtracks exponentially on input like `x=a=a=a=...`.
const ASSIGNMENT_WORD_RE = /^[A-Za-z_]\w*\+?=(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"]*)(?:\s+|$)/;

function isPureAssignment(statement: string): boolean {
  let rest = statement;
  while (rest) {
    const match = rest.match(ASSIGNMENT_WORD_RE);
    if (!match) return false;
    rest = rest.slice(match[0].length);
  }
  return true;
}

function isShellSetup(statement: string): boolean {
  if (!statement) return true;
  if (isPureAssignment(statement)) return true;
  return SHELL_SETUP_COMMANDS.has(splitFirstToken(statement).head);
}

function describeBashCommand(command: string, status: ToolStatus): ReadableToolDisplay {
  if (/computer-use\/(?:skills\/)?computer-use\/SKILL\.md|skills\/computer-use\/SKILL\.md/.test(command)) {
    return {
      verb: pickVerb(['Reading', 'Read'], status),
      target: 'Computer Use skill',
    };
  }
  const inner = unwrapShellCommand(command);
  // Title the row after the first statement that does real work, so a
  // leading `cd dir &&` or `VAR=...` never becomes the whole label, and say
  // how many other working statements the title leaves out.
  const statements = splitShellStatements(inner).map(stripControlKeywords);
  const working = statements.filter((statement) => !isShellSetup(statement));
  const lead = working[0] || statements[0] || inner;
  const display = describeShellStatement(lead, status);
  const hidden = Math.max(0, working.length - 1);
  return hidden > 0 ? { ...display, target: `${display.target} +${hidden} more` } : display;
}

function describeShellStatement(firstSegment: string, status: ToolStatus): ReadableToolDisplay {
  const { head, rest } = splitFirstToken(firstSegment);

  if (head === 'git') {
    const gitTokens = rest.split(/\s+/).filter(Boolean);
    const subcommand = gitTokens[0] || '';
    const gitVerbs = GIT_VERBS[subcommand];
    const target = `git ${truncate(rest, 40)}`.trim();
    return {
      verb: pickVerb(gitVerbs || DEFAULT_VERB, status),
      target: target || 'git',
    };
  }

  const shellVerbs = SHELL_TOOL_VERBS[head];
  if (shellVerbs) {
    const verb = pickVerb(shellVerbs, status);

    if (head === 'cat' || head === 'head' || head === 'tail' || head === 'less' || head === 'more' || head === 'bat') {
      const file = firstNonFlagToken(rest);
      return { verb, target: file ? lastPathSegment(file) : 'file' };
    }

    if (head === 'ls' || head === 'tree') {
      const dir = firstNonFlagToken(rest);
      return { verb, target: dir || 'directory' };
    }

    if (head === 'rg' && /(?:^|\s)--files(?:\s|$)/.test(rest)) {
      return { verb: pickVerb(['Listing', 'Listed'], status), target: 'files' };
    }

    if (head === 'grep' || head === 'rg' || head === 'ag') {
      const pattern = firstNonFlagToken(rest);
      return { verb, target: pattern ? `for ${truncate(pattern, 40)}` : 'pattern' };
    }

    if (head === 'find' || head === 'fd') {
      const path = firstNonFlagToken(rest);
      const nameFlag = rest.match(/-name\s+(['"]?)([^'"\s]+)\1/);
      const pattern = nameFlag ? nameFlag[2] : null;
      if (path && pattern) return { verb, target: `${pattern} in ${path}` };
      if (pattern) return { verb, target: pattern };
      if (path) return { verb, target: `in ${path}` };
      return { verb, target: truncate(rest || head, 50) };
    }

    if (head === 'rm' || head === 'mkdir' || head === 'touch') {
      const target = firstNonFlagToken(rest);
      return { verb, target: target || (head === 'mkdir' ? 'directory' : 'file') };
    }

    if (head === 'cp' || head === 'mv') {
      return { verb, target: truncate(rest, 50) };
    }

    if (head === 'curl' || head === 'wget') {
      const urlMatch = rest.match(/https?:\/\/\S+/);
      return { verb, target: urlMatch ? truncate(urlMatch[0], 60) : truncate(rest, 50) };
    }
  }

  // Package managers and language runtimes — keep the full short command.
  if (
    head === 'npm' ||
    head === 'yarn' ||
    head === 'pnpm' ||
    head === 'bun' ||
    head === 'node' ||
    head === 'python' ||
    head === 'python3' ||
    head === 'go' ||
    head === 'cargo' ||
    head === 'make' ||
    head === 'docker' ||
    head === 'kubectl' ||
    head === 'pip' ||
    head === 'pip3' ||
    head === 'tsc' ||
    head === 'deno'
  ) {
    return {
      verb: pickVerb(DEFAULT_VERB, status),
      target: truncate(`${head} ${rest}`.trim(), 60),
    };
  }

  return {
    verb: pickVerb(DEFAULT_VERB, status),
    target: truncate(firstSegment, 60),
  };
}

export function deriveReadableToolDisplay(
  name: string,
  input: unknown,
  status: ToolStatus
): ReadableToolDisplay {
  const providerTitle = getProviderDisplayTitle(input);
  if (providerTitle) {
    return { verb: '', target: providerTitle };
  }

  if (name === 'wait_agent') return { verb: status === 'pending' ? 'Waiting for' : 'Waited for', target: 'subagent result' };
  if (name === 'send_input') return { verb: status === 'error' ? 'Could not send' : status === 'pending' ? 'Sending' : 'Sent', target: 'supplementary message' };
  if (name === 'close_agent') return { verb: status === 'pending' ? 'Stopping' : 'Stopped', target: 'subagent' };
  if (name === 'Bash' || name === 'bash') {
    const command = getStringField(input, 'command') || getStringField(input, 'cmd');
    if (command) {
      return describeBashCommand(command, status);
    }
    return { verb: pickVerb(DEFAULT_VERB, status), target: 'command' };
  }

  if (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'Delete' || name === 'MultiEdit'
    || name === 'read' || name === 'write' || name === 'edit' || name === 'delete') {
    const path =
      getStringField(input, 'file_path') ||
      getStringField(input, 'path') ||
      getStringField(input, 'filename') ||
      '';
    const verbs = TOOL_VERBS[name] || DEFAULT_VERB;
    return { verb: pickVerb(verbs, status), target: path ? lastPathSegment(path) : 'file' };
  }

  if (name === 'LS' || name === 'ls') {
    const path = getStringField(input, 'path') || '.';
    return { verb: pickVerb(SHELL_TOOL_VERBS.ls, status), target: path };
  }

  if (name === 'Glob' || name === 'glob') {
    const pattern = getStringField(input, 'pattern') || '';
    return { verb: pickVerb(TOOL_VERBS.Glob, status), target: pattern || 'pattern' };
  }

  if (name === 'Grep' || name === 'grep') {
    const pattern = getStringField(input, 'pattern') || '';
    return { verb: pickVerb(TOOL_VERBS.Grep, status), target: pattern ? `for ${truncate(pattern, 40)}` : 'pattern' };
  }

  if (name === 'WebFetch' || name === 'web_fetch') {
    const url = getStringField(input, 'url') || '';
    return { verb: pickVerb(TOOL_VERBS.WebFetch, status), target: url ? truncate(url, 60) : 'url' };
  }

  if (name === 'WebSearch' || name === 'web_search') {
    const query = getStringField(input, 'query') || '';
    return { verb: pickVerb(TOOL_VERBS.WebSearch, status), target: query ? truncate(query, 60) : 'query' };
  }

  if (name === 'Task' || name === 'task' || name === 'subagent' || name === 'spawn_agent' || name === 'run_workflow') {
    const desc =
      getStringField(input, 'description') ||
      getStringField(input, 'subagent_type') ||
      getStringField(input, 'prompt') ||
      getStringField(input, 'task') ||
      getStringField(input, 'message') ||
      '';
    return { verb: pickVerb(TOOL_VERBS.Task, status), target: desc ? truncate(desc, 60) : 'subagent task' };
  }

  if (name === 'TodoWrite' || name === 'todo_write') {
    return { verb: pickVerb(TOOL_VERBS.TodoWrite, status), target: 'todo list' };
  }

  if (name === 'NotebookEdit') {
    const path = getStringField(input, 'notebook_path') || getStringField(input, 'path') || '';
    return { verb: pickVerb(TOOL_VERBS.NotebookEdit, status), target: path ? lastPathSegment(path) : 'notebook' };
  }

  if (name === 'AskUserQuestion') {
    const summary = getToolSummary(name, input);
    return { verb: pickVerb(DEFAULT_VERB, status), target: summary ? truncate(summary, 60) : 'question' };
  }

  const action = classifyComputerUseAction({
    toolName: name,
    app: getStringField(input, 'app'),
    title: getProviderDisplayTitle(input),
  });
  if (action) {
    const mappedStatus =
      status === 'error' ? 'error' : status === 'interrupted' ? 'interrupted' : status === 'success' ? 'success' : 'pending';
    return { verb: '', target: formatComputerUseLabel(action, mappedStatus) };
  }

  // MCP-style names like "mcp__server__tool" — show just the tool segment.
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    const toolName = parts[parts.length - 1] || name;
    const summary = getToolSummary(name, input);
    return {
      verb: pickVerb(DEFAULT_VERB, status),
      target: summary ? `${toolName} ${truncate(summary, 40)}`.trim() : toolName,
    };
  }

  // Unknown tool — fall back to the legacy summary.
  const fallback = getToolSummary(name, input);
  return {
    verb: pickVerb(DEFAULT_VERB, status),
    target: fallback ? truncate(fallback, 60) : name,
  };
}

export function formatReadableToolSummary(display: ReadableToolDisplay): string {
  return `${display.verb} ${display.target}`.trim();
}

// ── Canonical kind classification ───────────────────────────────────────────
// Maps a provider's tool name (currently Claude-shaped because CodexAdapter
// translates Codex events back into Anthropic wire format) to a canonical kind
// the UI can switch on without caring which provider produced it. New tool
// names from new providers slot in here rather than fanning out across UI
// components.

const SHELL_FILE_READERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat',
]);

function detectBashKind(command: string | null | undefined): CanonicalToolKind {
  if (!command) return 'command_execution';
  const inner = unwrapShellCommand(command);
  const firstSegment = inner.split(/\s+&&\s+|\s+\|\|\s+|\s*;\s*|\s*\|\s*/)[0] || inner;
  const { head } = splitFirstToken(firstSegment);
  if (SHELL_FILE_READERS.has(head)) return 'file_read';
  if (head === 'ls' || head === 'tree' || head === 'grep' || head === 'rg' || head === 'ag' || head === 'find' || head === 'fd' || head === 'glob') {
    return 'pattern_search';
  }
  return 'command_execution';
}

export function classifyToolUse(toolName: string, input: unknown): CanonicalToolKind {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === 'read' || normalized === 'read_image') return 'file_read';
  if (['write', 'edit', 'multiedit', 'delete', 'notebookedit'].includes(normalized)) {
    return 'file_change';
  }
  if (normalized === 'bash') {
    return detectBashKind(getStringField(input, 'command') || getStringField(input, 'cmd'));
  }
  if (normalized === 'grep' || normalized === 'glob' || normalized === 'ls') return 'pattern_search';
  if (normalized === 'websearch' || normalized === 'webfetch' || normalized === 'web_search' || normalized === 'web_fetch') return 'web_search';
  // The subagent-spawning tool is "Task" in the Claude Agent SDK and "Agent"
  // in this runtime; both carry a subagent_type input. Recognize either name,
  // or any tool that declares a subagent_type, so every runtime's subagent
  // runs render as a subagent board (not a generic tool row).
  if (normalized === 'task' || normalized === 'agent' || normalized === 'subagent') return 'subagent';
  if (getStringField(input, 'subagent_type')) return 'subagent';
  // Bubble's spawn surface: spawn_agent (one child) and run_workflow (a
  // schema'd multi-agent pipeline) both nest their children the same way.
  if (normalized === 'spawn_agent' || normalized === 'run_workflow') return 'subagent';
  // Cross-agent delegation (aegis-delegate MCP server): a delegate_task call
  // runs another agent whose trace mirrors into this session exactly like a
  // subagent — render it as one, not as a generic MCP row.
  if (normalized === 'delegate_task' || normalized.endsWith('__delegate_task')) return 'subagent';
  if (
    normalized === 'image_gen' ||
    normalized === 'image_edit' ||
    normalized === 'image_to_video' ||
    normalized === 'reference_to_video' ||
    normalized === 'imagine' ||
    normalized === 'imagine-video'
  ) {
    return 'image_view';
  }
  if (normalized === 'todowrite' || normalized === 'todo_write') return 'todo_update';
  if (normalized === 'askuserquestion' || normalized === 'question') return 'approval';
  if (
    toolName === 'remember_search' ||
    toolName === 'remember_get' ||
    toolName === 'remember_write' ||
    toolName === 'remember_recent' ||
    toolName.startsWith('aegis_memory_') ||
    toolName.endsWith('__remember_search') ||
    toolName.endsWith('__remember_get') ||
    toolName.endsWith('__remember_write') ||
    toolName.endsWith('__remember_recent')
  ) {
    return 'memory';
  }
  if (classifyComputerUseAction({ toolName, app: getStringField(input, 'app'), title: getProviderDisplayTitle(input) })) {
    return 'computer_use';
  }
  const parsed = parseMcpToolName(toolName);
  if (parsed && classifyComputerUseAction({ server: parsed.server, tool: parsed.tool, toolName })) {
    return 'computer_use';
  }
  if (toolName.startsWith('mcp__')) return 'mcp_tool_call';
  return 'unknown';
}
