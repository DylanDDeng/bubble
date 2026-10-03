/**
 * Session-scoped set of bash commands the user approved "for this session".
 * Not persisted to disk.
 *
 * Exact match only (after trimming), like Kimi Code's session approvals: a
 * remembered command never vouches for a different one, so no shell parsing
 * is involved and a compound line cannot smuggle an extra command past it.
 * Broader, prefix-style grants belong in allow rules (`Bash(npm test:*)`),
 * which are matched per simple command.
 */
export class BashAllowlist {
  private commands = new Set<string>();

  add(command: string): void {
    const cleaned = command.trim();
    if (!cleaned) return;
    this.commands.add(cleaned);
  }

  remove(command: string): boolean {
    return this.commands.delete(command.trim());
  }

  clear(): void {
    this.commands.clear();
  }

  matches(command: string): boolean {
    return this.commands.has(command.trim());
  }

  list(): string[] {
    return [...this.commands].sort();
  }

  size(): number {
    return this.commands.size;
  }
}

/** What a "this session" approval of `command` remembers: the command itself. */
export function bashSessionGrant(command: string): string | undefined {
  return command.trim() || undefined;
}
