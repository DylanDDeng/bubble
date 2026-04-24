import type { ContentPart } from "../types.js";

export type TaskType = "security_investigation" | "code_search" | "general";

const SECURITY_PATTERNS = [
  /\bapi[\s_-]?key\b/i,
  /\bsecret(s)?\b/i,
  /\btoken(s)?\b/i,
  /\bcredential(s)?\b/i,
  /\bleak(ed|age)?\b/i,
  /\bexpos(e|ed|ure)\b/i,
  /\bstored?\b/i,
  /\bwhere\b/i,
  /\bconfig\b/i,
  /\benv\b/i,
];

const SEARCH_PATTERNS = [
  /\bfind\b/i,
  /\bsearch\b/i,
  /\blook for\b/i,
  /\bwhere\b/i,
  /\blocate\b/i,
  /\btrace\b/i,
];

export function classifyTask(input: string | ContentPart[]): TaskType {
  const text = typeof input === "string"
    ? input
    : input
      .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");

  const securityHits = SECURITY_PATTERNS.filter((pattern) => pattern.test(text)).length;
  if (securityHits >= 2) {
    return "security_investigation";
  }

  if (SEARCH_PATTERNS.some((pattern) => pattern.test(text))) {
    return "code_search";
  }

  return "general";
}
