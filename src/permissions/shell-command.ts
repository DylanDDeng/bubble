/**
 * Just enough shell grammar for permission matching.
 *
 * Prefix rules ("git status", `Bash(npm run:*)`) used to compare against the
 * raw command string, so an approved `git status` also approved
 * `git status && rm -rf ~`, and a `Bash(rm:*)` deny rule missed
 * `echo ok && rm -rf x`. This splits a command into the simple commands it
 * runs and flags constructs whose effect cannot be judged from the visible
 * command words. It is deliberately not a full parser: anything it does not
 * understand is marked opaque, and opaque commands are never auto-allowed.
 */

export interface ShellCommandAnalysis {
  /**
   * Simple commands in source order, including ones nested inside command
   * substitution, backticks and process substitution. Leading control
   * keywords (`then`, `do`, `!`, `{`, ...) are stripped.
   */
  segments: string[];
  /**
   * The command contains something an allow rule cannot vouch for: command
   * or process substitution, backticks, a redirection to anything but
   * /dev/null or another fd, a heredoc, a compound statement header
   * (for/case/function), or unterminated quoting.
   */
  opaque: boolean;
}

/** Reserved words that may precede a command without changing what it runs. */
const LEADING_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time",
]);

/** Statement headers whose words are not a command at all. */
const OPAQUE_HEADERS = new Set(["for", "case", "select", "function", "esac"]);

const WORD_BREAK = /[\s;&|()<>]/;

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const segments: string[] = [];
  let opaque = false;
  let current = "";
  // Open contexts: a double quote, a `$(`/`<(`/`>(`/subshell closed by `)`,
  // or a backtick substitution.
  const stack: Array<'"' | ")" | "`"> = [];

  const flush = (): void => {
    const tokens = current.trim().split(/\s+/).filter(Boolean);
    current = "";
    while (tokens.length > 0 && LEADING_KEYWORDS.has(tokens[0])) tokens.shift();
    if (tokens.length === 0) return;
    if (OPAQUE_HEADERS.has(tokens[0])) opaque = true;
    segments.push(tokens.join(" "));
  };

  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i];
    const next = command[i + 1];
    const top = stack[stack.length - 1];

    if (top === '"') {
      if (c === "\\") { current += c + (next ?? ""); i++; continue; }
      if (c === '"') { stack.pop(); current += c; continue; }
      if (c === "$" && next === "(") { opaque = true; flush(); stack.push(")"); i++; continue; }
      if (c === "`") { opaque = true; flush(); stack.push("`"); continue; }
      current += c;
      continue;
    }

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) { opaque = true; current += command.slice(i); break; }
      current += command.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === "\\") { current += c + (next ?? ""); i++; continue; }
    if (c === '"') { stack.push('"'); current += c; continue; }
    if (c === "`") {
      opaque = true;
      flush();
      if (top === "`") stack.pop();
      else stack.push("`");
      continue;
    }
    if (c === "$" && next === "(") { opaque = true; flush(); stack.push(")"); i++; continue; }
    if ((c === "<" || c === ">") && next === "(") { opaque = true; flush(); stack.push(")"); i++; continue; }

    if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      // A redirection. Drop an fd number glued to the operator ("2>").
      current = current.replace(/(^|\s)\d+$/, "$1");
      let j = i + 1;
      let operator = c;
      while (j < n && /[<>&|]/.test(command[j])) { operator += command[j]; j++; }
      if (operator.startsWith("<<")) opaque = true; // heredoc / herestring
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;
      let k = j;
      while (k < n && !WORD_BREAK.test(command[k])) k++;
      const target = command.slice(j, k);
      const harmless = target === "/dev/null" || (operator.endsWith("&") && /^(\d+|-)$/.test(target));
      if (!harmless) opaque = true;
      i = k - 1;
      continue;
    }

    if (c === ")") { flush(); if (top === ")") stack.pop(); continue; }
    if (c === "(") { flush(); stack.push(")"); continue; }
    if (c === ";" || c === "\n" || c === "&" || c === "|") { flush(); continue; }

    current += c;
  }
  flush();
  if (stack.length > 0) opaque = true;
  return { segments, opaque };
}

export function shellTokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** Wrappers that run their argument as the real command. */
const COMMAND_WRAPPERS = new Set(["command", "exec", "nohup", "builtin", "env", "sudo", "doas", "nice", "xargs"]);

/**
 * The words of a segment with leading `VAR=value` assignments and command
 * wrappers (`sudo -u x`, `env`, `nohup`, ...) removed. Deny rules match
 * against this too, so `sudo rm -rf x` and `FOO=1 rm -rf x` still hit a
 * `Bash(rm:*)` deny. Best effort — deny rules on shell commands can always be
 * evaded by a determined command (e.g. `bash -c`), and are documented as such.
 */
export function effectiveCommandTokens(segment: string): string[] {
  const tokens = shellTokens(segment).map(unquoteWord);
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) { tokens.shift(); changed = true; }
    if (tokens.length > 0 && COMMAND_WRAPPERS.has(tokens[0])) {
      tokens.shift();
      while (tokens.length > 0 && tokens[0].startsWith("-")) tokens.shift();
      changed = true;
    }
  }
  // `/bin/rm` and `./rm` run the same program a `Bash(rm:*)` deny names.
  if (tokens.length > 0 && tokens[0].includes("/")) tokens[0] = tokens[0].slice(tokens[0].lastIndexOf("/") + 1);
  return tokens;
}

/** `'rm'`, `"rm"` and `r\m` are all the word rm to the shell. */
function unquoteWord(word: string): string {
  return word.replace(/\\(.)/g, "$1").replace(/['"]/g, "");
}
