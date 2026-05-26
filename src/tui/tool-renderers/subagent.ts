import { fg, StyledText, type Renderable } from "@opentui/core";
import { formatSubagentRoute, type SubagentRouteLike } from "../../agent/subagent-route-format.js";
import type { DisplayToolCall } from "../display-history.js";
import type { ToolRenderContext, ToolRenderer } from "./types.js";

interface SubagentDisplay {
  subAgentId?: string;
  agentName?: string;
  nickname?: string;
  category?: string;
  route?: SubagentRouteLike;
  status?: string;
  profileSource?: string;
  task?: string;
  summary?: string;
  toolNotes?: string[];
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export const subagentToolRenderer: ToolRenderer = {
  canRender: (tool: DisplayToolCall) => tool.name === "subagent" || tool.metadata?.kind === "subagent",
  render: renderSubagentTool,
};

function renderSubagentTool({ ctx, tool, width, helpers }: ToolRenderContext) {
  const { theme } = helpers;
  const metadata = tool.metadata ?? {};
  const subagents = subagentsFrom(tool);
  const mode = typeof metadata.mode === "string" ? metadata.mode : (subagents.length > 1 ? "parallel" : "single");
  const completed = subagents.filter((item) => item.status === "completed").length;
  const failed = subagents.filter((item) => ["failed", "blocked", "cancelled"].includes(item.status ?? "")).length;
  const color = tool.isError ? theme.toolError : tool.status === "running" ? theme.toolPending : theme.toolSuccess;
  const headerChunks: StyledText["chunks"] = [
    fg(color)(`> ${helpers.displayToolName(tool.name)}`),
    fg(theme.toolText)(` ${mode}`),
  ];
  if (subagents.length > 0) {
    headerChunks.push(fg(theme.textMuted)(` ${completed}/${subagents.length}`));
    if (failed > 0) headerChunks.push(fg(theme.toolError)(` ${failed} failed`));
  }

  const children: Renderable[] = [
    helpers.createText(ctx, new StyledText(headerChunks), { wrapMode: "word" }),
  ];

  const rows = sortSubagents(subagents).map((subagent) => renderSubagentRow(ctx, subagent, width, helpers));
  if (rows.length > 0) {
    children.push(helpers.createBox(ctx, {
      paddingLeft: 1,
      marginTop: 0,
      border: ["left"],
      borderColor: theme.borderSubtle,
      flexDirection: "column",
      flexShrink: 0,
    }, rows));
  } else if (tool.result) {
    children.push(helpers.createText(ctx, helpers.summarizeToolResult(tool), {
      fg: tool.isError ? theme.toolError : theme.textMuted,
      wrapMode: "word",
    }));
  }

  return helpers.createBox(ctx, {
    paddingLeft: 3,
    marginTop: 1,
    flexDirection: "column",
    flexShrink: 0,
  }, children);
}

function renderSubagentRow(
  ctx: ToolRenderContext["ctx"],
  subagent: SubagentDisplay,
  width: number,
  helpers: ToolRenderContext["helpers"],
) {
  const { theme } = helpers;
  const status = subagent.status ?? "running";
  const color = status === "completed"
    ? theme.toolSuccess
    : status === "running" || status === "queued"
      ? theme.toolPending
      : theme.toolError;
  const source = subagent.profileSource ? ` [${subagent.profileSource}]` : "";
  const usage = subagent.usage?.totalTokens ? ` ${subagent.usage.totalTokens} tokens` : "";
  const summary = firstUsefulLine(subagent.error || subagent.summary || lastToolNote(subagent.toolNotes));
  const task = firstUsefulLine(subagent.task);
  const maxLine = Math.max(24, width - 12);
  const descriptor = subagentDescriptor(subagent, true);

  const lines = [
    helpers.createText(ctx, new StyledText([
      fg(color)(`${statusIcon(status)} ${subagentLabel(subagent)}`),
      fg(theme.textMuted)(` ${descriptor}${source} ${status}${usage}`),
    ]), { wrapMode: "word" }),
  ];
  if (task) {
    lines.push(helpers.createText(ctx, shorten(`task: ${task}`, maxLine), {
      fg: theme.textMuted,
      wrapMode: "word",
    }));
  }
  if (summary) {
    lines.push(helpers.createText(ctx, shorten(summary, maxLine), {
      fg: subagent.error ? theme.toolError : theme.toolText,
      wrapMode: "word",
    }));
  }

  return helpers.createBox(ctx, {
    flexDirection: "column",
    flexShrink: 0,
  }, lines);
}

function subagentLabel(subagent: SubagentDisplay): string {
  return subagent.nickname ?? subagent.agentName ?? "subagent";
}

function subagentRole(subagent: SubagentDisplay): string {
  return [subagent.agentName, subagent.category ? `/${subagent.category}` : ""].join("") || "default";
}

function subagentDescriptor(subagent: SubagentDisplay, includeThinking = false): string {
  const route = formatSubagentRoute(subagent.route, { includeThinking });
  const role = subagentRole(subagent);
  return route ? `${role} @ ${route}` : role;
}

function subagentsFrom(tool: DisplayToolCall): SubagentDisplay[] {
  const raw = tool.metadata?.subagents;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is SubagentDisplay => typeof item === "object" && item !== null);
}

function statusIcon(status: string): string {
  if (status === "completed") return "+";
  if (status === "running") return ">";
  if (status === "queued") return ".";
  return "!";
}

function sortSubagents(subagents: SubagentDisplay[]): SubagentDisplay[] {
  const rank: Record<string, number> = {
    running: 0,
    blocked: 1,
    failed: 2,
    queued: 3,
    cancelled: 4,
    completed: 5,
  };
  return [...subagents].sort((a, b) => (rank[a.status ?? "running"] ?? 9) - (rank[b.status ?? "running"] ?? 9));
}

function lastToolNote(notes: string[] | undefined): string | undefined {
  return notes?.filter(Boolean).at(-1);
}

function firstUsefulLine(value: string | undefined): string {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}
