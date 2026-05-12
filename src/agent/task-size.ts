import type { ContentPart } from "../types.js";

/**
 * Coarse "is this a small / focused task" classifier. Used to inject a hint
 * that suppresses the default exploration-first protocol when the user's
 * request is clearly a one-shot create or single-file tweak. Counterpart to
 * `task-classifier.ts` which categorizes by *kind*, not *size*.
 */

export type TaskSize = "small" | "normal";

// Two-part match: a "create" verb AND a "deliverable" noun in the same
// sentence is a strong signal of a focused, one-shot task.
const SMALL_TASK_VERBS = [
  /\b(write|create|generate|make|draft|build|add)\b/i,
  /帮我写|帮我创建|帮我生成|写(个|一个|一份)|新建一个|做(个|一个|一份)|生成(个|一个|一份)|搞(个|一个|一份)/i,
];

const SMALL_TASK_NOUNS = [
  /\b(file|page|component|script|snippet|function|class|test|html|css|js|ts|tsx|jsx|md|markdown|hello world)\b/i,
  /(文件|页面|组件|脚本|片段|函数|类|测试|html|css|介绍|文章|页|说明|示例|demo)/i,
];

function matchesSmallTaskPattern(text: string): boolean {
  return SMALL_TASK_VERBS.some((re) => re.test(text))
    && SMALL_TASK_NOUNS.some((re) => re.test(text));
}

const LARGE_TASK_NEGATIONS = [
  /\b(refactor|rewrite|migrate|overhaul|integrate|architect|review the codebase|whole project|across the codebase)\b/i,
  /多个|批量|全部|所有|整个项目|整个仓库|架构|重构|端到端|跨模块/i,
];

export function classifyTaskSize(input: string | ContentPart[]): TaskSize {
  const text = (typeof input === "string"
    ? input
    : input
      .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
  ).trim();

  if (!text) return "normal";

  // Up to ~120 chars with a small-task verb+noun match and no negation: small.
  if (text.length <= 120 && matchesSmallTaskPattern(text)) {
    return LARGE_TASK_NEGATIONS.some((re) => re.test(text)) ? "normal" : "small";
  }

  return "normal";
}
