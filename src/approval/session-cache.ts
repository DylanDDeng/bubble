/**
 * Session-scoped allowlist of bash command prefixes. Not persisted to disk.
 *
 * Matching rule: a command is allowed if it starts with one of the stored
 * prefixes and the next character is either end-of-string or whitespace.
 * This means the prefix "git status" will match "git status" and
 * "git status -s", but NOT "git statuss" or "git statusbad".
 *
 * For ergonomic parity with Claude Code we also strip a trailing ":*" when
 * storing so that users may type "npm run:*" as a pattern — functionally
 * equivalent to just "npm run" under our simple prefix rule.
 */
export class BashAllowlist {
  private prefixes = new Set<string>();

  add(prefix: string): void {
    const cleaned = prefix.trim().replace(/:\*$/, "").trim();
    if (!cleaned) return;
    this.prefixes.add(cleaned);
  }

  remove(prefix: string): boolean {
    return this.prefixes.delete(prefix.trim());
  }

  clear(): void {
    this.prefixes.clear();
  }

  matches(command: string): boolean {
    const trimmed = command.trim();
    for (const prefix of this.prefixes) {
      if (trimmed === prefix) return true;
      if (trimmed.startsWith(prefix) && /\s/.test(trimmed.charAt(prefix.length))) {
        return true;
      }
    }
    return false;
  }

  list(): string[] {
    return [...this.prefixes].sort();
  }

  size(): number {
    return this.prefixes.size;
  }
}

/**
 * Infers a reasonable "don't ask again" prefix from a bash command. Uses the
 * first two whitespace-separated tokens when the second token looks like a
 * subcommand (no leading `-` or `/`), otherwise falls back to the first token.
 * Examples:
 *   "git status -s"     → "git status"
 *   "git status"        → "git status"
 *   "git"               → "git"
 *   "npm run test"      → "npm run"
 *   "npm test"          → "npm test"
 *   "rm -rf /tmp/x"     → "rm"
 *   "./scripts/foo.sh"  → "./scripts/foo.sh"
 */
export function inferBashPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return "";
  const first = tokens[0];
  const second = tokens[1];
  if (second && /^[A-Za-z_]/.test(second)) {
    return `${first} ${second}`;
  }
  return first;
}
