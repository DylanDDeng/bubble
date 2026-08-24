/**
 * Pure parser for the `/goal` slash command.
 *
 * Forms:
 *   /goal                      -> show summary
 *   /goal <objective> [--budget N]  -> set a new goal
 *   /goal status | clear | pause | resume
 *   /goal edit <new objective>
 *
 * --budget accepts plain integers and k/m suffixes: 200000, 200k, 1.5m.
 */

export type GoalCommandKind = "show" | "set" | "clear" | "pause" | "resume" | "edit";

export interface GoalCommand {
  kind: GoalCommandKind;
  objective?: string;
  tokenBudget?: number;
  error?: string;
}

const SUBCOMMANDS = new Set(["status", "clear", "pause", "resume", "edit"]);

export function parseGoalCommand(input: string): GoalCommand {
  const body = input.trim().replace(/^\/goal\b/, "").trim();
  if (!body) return { kind: "show" };

  const firstToken = body.split(/\s+/, 1)[0]!.toLowerCase();
  const rest = body.slice(firstToken.length).trim();

  if (SUBCOMMANDS.has(firstToken)) {
    if (firstToken === "status") {
      if (rest) return { kind: "show", error: "/goal status takes no arguments" };
      return { kind: "show" };
    }
    if (firstToken === "edit") {
      if (!rest) return { kind: "edit", error: "Usage: /goal edit <new objective>" };
      const { text, tokenBudget, error } = extractBudget(rest);
      if (error) return { kind: "edit", error };
      const objective = text.trim();
      if (!objective) return { kind: "edit", error: "Usage: /goal edit <new objective>" };
      return { kind: "edit", objective, tokenBudget };
    }
    // clear / pause / resume take no arguments.
    if (rest) return { kind: firstToken as GoalCommandKind, error: `/goal ${firstToken} takes no arguments` };
    return { kind: firstToken as GoalCommandKind };
  }

  // Anything else is a new objective.
  const { text, tokenBudget, error } = extractBudget(body);
  if (error) return { kind: "set", error };
  const objective = text.trim();
  if (!objective) return { kind: "set", error: "Usage: /goal <objective> [--budget N]" };
  return { kind: "set", objective, tokenBudget };
}

function extractBudget(s: string): { text: string; tokenBudget?: number; error?: string } {
  const match = s.match(/--budget(?:=|\s+)(\S+)/);
  if (!match || match.index === undefined) return { text: s };
  const value = parseBudgetValue(match[1]!);
  if (value === undefined || value <= 0) {
    return { text: s, error: `Invalid --budget value: "${match[1]}" (use e.g. 200000, 200k, 1.5m)` };
  }
  const text = (s.slice(0, match.index) + s.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return { text, tokenBudget: value };
}

export function parseBudgetValue(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)([kmKM]?)$/);
  if (!match) return undefined;
  let value = parseFloat(match[1]!);
  if (!Number.isFinite(value)) return undefined;
  const suffix = match[2]!.toLowerCase();
  if (suffix === "k") value *= 1_000;
  else if (suffix === "m") value *= 1_000_000;
  return Math.round(value);
}
