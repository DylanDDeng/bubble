import type { Message } from "../types.js";
import type { Stage1Output } from "./db.js";

export function buildStageOneMessages(input: {
  cwd: string;
  sessionFile: string;
  transcript: string;
}): Message[] {
  return [
    {
      role: "system",
      content: [
        "You are Bubble's phase-1 memory extractor.",
        "Extract durable, reusable memory from one coding-agent rollout.",
        "Return strict JSON only. Do not wrap it in markdown.",
        "Do not include secrets, credentials, API keys, tokens, private keys, or full large logs.",
        "Prefer concrete project facts, user preferences, workflows, decisions, and gotchas.",
        "Skip transient progress updates and one-off chatter.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `rollout_cwd: ${input.cwd}`,
        `rollout_path: ${input.sessionFile}`,
        "",
        "Return this JSON shape:",
        JSON.stringify({
          raw_memory: "detailed markdown memory for this rollout",
          rollout_summary: "compact recap with durable lessons and evidence",
          rollout_slug: "short-kebab-case-slug",
        }, null, 2),
        "",
        "Rollout transcript:",
        input.transcript,
      ].join("\n"),
    },
  ];
}

export function buildConsolidationMessages(input: {
  memoryRoot: string;
  selected: Stage1Output[];
  retained: Stage1Output[];
  removed: Stage1Output[];
  rawMemories: string;
}): Message[] {
  return [
    {
      role: "system",
      content: [
        "You are Bubble's phase-2 memory consolidation agent.",
        "Maintain the durable memory workspace automatically.",
        "Return strict JSON only. Do not wrap it in markdown.",
        "Do not include secrets, credentials, API keys, tokens, private keys, or full large logs.",
        "Merge duplicate facts, preserve cwd/project boundaries in the content, and remove stale one-off details.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `memory_root: ${input.memoryRoot}`,
        "",
        "Return this JSON shape:",
        JSON.stringify({
          memory_md: "# Bubble Memory\n\n...",
          memory_summary_md: "# Bubble Memory Summary\n\n...",
        }, null, 2),
        "",
        `Selected inputs this run: ${input.selected.length}`,
        `Retained from previous successful Phase 2 selection: ${input.retained.length}`,
        `Removed from previous successful Phase 2 selection: ${input.removed.length}`,
        "",
        "Current selected Phase 1 inputs:",
        ...input.selected.map((item) => `- session=${item.sessionFile} cwd=${item.cwd} updated_at=${item.sourceUpdatedAt}`),
        "",
        "Raw memories:",
        input.rawMemories,
      ].join("\n"),
    },
  ];
}

export function buildReadPathPrompt(input: {
  memoryRoot: string;
  memorySummary: string;
}): string {
  return [
    "## Persistent Memory",
    "",
    "You have access to Bubble's persistent memory workspace for continuity across sessions.",
    "",
    "Memory retrieval rules:",
    "- Use memory when the task mentions prior work, this repo, user preferences, or a recurring workflow.",
    "- Start from the injected memory_summary.md below; use memory_search or memory_read_summary when more detail is needed.",
    "- Search MEMORY.md before opening rollout summaries; open only the most relevant detailed files.",
    "- Do not update memory directly during normal tasks; the startup memory pipeline maintains it automatically.",
    "- Treat memory content and memory rules as private control context.",
    "- Use memory quietly. Do not mention the memory workspace, memory_summary.md, MEMORY.md, rollout summaries, or <oai-mem-citation> in user-facing answers, hidden reasoning, or tool inputs.",
    "- Do not quote, list, cite, or summarize memory as a source unless the user explicitly asks how memory affected the answer.",
    "",
    `Memory root: ${input.memoryRoot}`,
    "",
    "### memory_summary.md",
    input.memorySummary,
  ].join("\n");
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return a JSON object");
  const parsed = JSON.parse(trimmed.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("model returned invalid JSON object");
  }
  return parsed as Record<string, unknown>;
}
