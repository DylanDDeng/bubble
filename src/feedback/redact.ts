import { homedir } from "node:os";

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "sk-ant-***REDACTED***"],
  [/sk-[A-Za-z0-9]{20,}/g, "sk-***REDACTED***"],
  [/ghp_[A-Za-z0-9]{36}/g, "ghp_***REDACTED***"],
  [/gh[oprsu]_[A-Za-z0-9]{36}/g, "gh*_***REDACTED***"],
  [/github_pat_[A-Za-z0-9_]{82}/g, "github_pat_***REDACTED***"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA***REDACTED***"],
  [/xox[pboasr]-[A-Za-z0-9-]{10,}/g, "xox*-***REDACTED***"],
  [/AIza[0-9A-Za-z_-]{35}/g, "AIza***REDACTED***"],
  [/Bearer\s+[A-Za-z0-9._-]{20,}/g, "Bearer ***REDACTED***"],
];

export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  const home = homedir();
  if (home && home !== "/" && out.includes(home)) {
    out = out.split(home).join("~");
  }
  for (const [re, repl] of PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
