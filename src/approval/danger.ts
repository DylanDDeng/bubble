/**
 * Heuristic classifier for bash commands that deserve an extra user warning.
 *
 * Conservative by design: false negatives are fine (users are still prompted
 * to approve), false positives are annoying (users get desensitised to the
 * warning). We only flag patterns that are widely recognised as destructive
 * or commonly abused by injected prompts.
 */

export interface DangerSignal {
  pattern: string;
  message: string;
}

export function classifyBashDanger(command: string): DangerSignal | null {
  const normalized = command.trim();
  if (!normalized) return null;

  // Piping an internet download into a shell — classic supply-chain foot-gun.
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(bash|sh|zsh|fish)\b/i.test(normalized)) {
    return {
      pattern: "curl | sh",
      message: "This command pipes a downloaded script directly into a shell.",
    };
  }

  // Recursive force delete. Match `rm -rf`, `rm -fr`, `rm -Rf`, etc.
  if (/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/.test(normalized)) {
    return {
      pattern: "rm -rf",
      message: "This command recursively deletes files and directories.",
    };
  }

  // Privilege escalation.
  if (/\bsudo\b/.test(normalized)) {
    return {
      pattern: "sudo",
      message: "This command runs with elevated privileges.",
    };
  }

  // chmod 777 and friends.
  if (/\bchmod\s+(-R\s+)?(0?777|a\+rwx|u\+rwx,g\+rwx,o\+rwx)\b/.test(normalized)) {
    return {
      pattern: "chmod 777",
      message: "This command gives world-writable permissions.",
    };
  }

  // Git force push / reset hard — potentially destructive on shared branches.
  if (/\bgit\s+push\s+(-f\b|--force\b|--force-with-lease\b)/.test(normalized)) {
    return {
      pattern: "git push --force",
      message: "This force-pushes and can overwrite the remote branch history.",
    };
  }
  if (/\bgit\s+reset\s+--hard\b/.test(normalized)) {
    return {
      pattern: "git reset --hard",
      message: "This discards uncommitted changes and rewrites the working tree.",
    };
  }

  return null;
}
