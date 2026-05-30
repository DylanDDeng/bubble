import type { ContentPart } from "../types.js";

export type TaskType =
  | "security_investigation"
  | "debugging"
  | "implementation"
  | "code_review"
  | "code_explanation"
  | "repo_orientation"
  | "product_discussion"
  | "code_search"
  | "general";

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

const REVIEW_PATTERNS = [
  /\breview\b/i,
  /\bcode review\b/i,
  /帮我看看.*(代码|改动|diff)/i,
  /看下.*(风险|问题|bug)/i,
];

const DEBUG_PATTERNS = [
  /\bdebug\b/i,
  /\bbug\b/i,
  /\bfail(ing|ed|ure)?\b/i,
  /\berror\b/i,
  /\bregression\b/i,
  /报错|失败|不对|有问题|修复|定位/i,
];

const IMPLEMENTATION_PATTERNS = [
  /\bimplement\b/i,
  /\bbuild\b/i,
  /\badd\b/i,
  /\bchange\b/i,
  /\bupdate\b/i,
  /\brefactor\b/i,
  /实现|开发|改一下|加一个|调整|优化/i,
];

const EXPLANATION_PATTERNS = [
  /\bexplain\b/i,
  /\bhow does\b/i,
  /\bwhat does\b/i,
  /解释|讲讲|怎么看|在干嘛|如何运转/i,
];

const ORIENTATION_PATTERNS = [
  /\bwhat is this project\b/i,
  /\bwhat is this (repo|repository)\b/i,
  /\borient/i,
  /\boverview\b/i,
  /\b(repo|repository|project) overview\b/i,
  /这个项目.*(干嘛|做什么)|这项目.*(干嘛|做什么)|这个\s*repo.*(干嘛|做什么)|看下(这个|这)?项目|项目.*概览|快速了解.*项目/i,
];

const CONCRETE_ORIENTATION_EXCLUSIONS = [
  /项目[中里内]\s*[,，]?\s*\S{2,}/i,
  /帮我.*(实现|开发|改|加|调整|优化|修复)/i,
  /(实现|开发|改一下|加一个|调整|优化|修复|支持|报错|失败|不对|有问题|bug|commit|push)/i,
  /(?:\.[a-z][\w-]*|\b[A-Z]{2,}\b)/,
];

const PRODUCT_PATTERNS = [
  /\bproduct\b/i,
  /\bdesign\b/i,
  /\bstrategy\b/i,
  /\broadmap\b/i,
  /产品|方案|设计|体验|取舍|方向/i,
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

  if (REVIEW_PATTERNS.some((pattern) => pattern.test(text))) {
    return "code_review";
  }

  if (DEBUG_PATTERNS.some((pattern) => pattern.test(text))) {
    return "debugging";
  }

  if (IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return "implementation";
  }

  if (isLikelyRepoOrientation(text)) {
    return "repo_orientation";
  }

  if (EXPLANATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return "code_explanation";
  }

  if (PRODUCT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "product_discussion";
  }

  if (SEARCH_PATTERNS.some((pattern) => pattern.test(text))) {
    return "code_search";
  }

  return "general";
}

function isLikelyRepoOrientation(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!ORIENTATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (CONCRETE_ORIENTATION_EXCLUSIONS.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return normalized.length <= 80;
}
