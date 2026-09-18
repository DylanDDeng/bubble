/**
 * Background task lifecycle projection for the transcript.
 *
 * A `bash run_in_background` call settles as soon as the process is spawned,
 * leaving a "Task started" row in the trace. When the task later finishes,
 * its terminal state (completed / failed / killed, exit code, duration,
 * output tail) is landed on that same launch row by task id, so the reader
 * sees the outcome where the command was issued rather than as a detached
 * row appended after the assistant's answer.
 *
 * A synthetic terminal row is only produced when no launch row exists (the
 * transcript was cleared, or the task was started outside this transcript).
 */
import type { BackgroundTaskInfo } from "../../tasks/manager.js";
import { nextDisplayMessageKey, type DisplayMessage, type DisplayToolCall } from "./display-history.js";
import { mapTranscriptTools } from "./subagent-view.js";

export interface TaskLifecycleTerminal {
  task: BackgroundTaskInfo;
  output?: string;
}

function isLaunchRowFor(tool: DisplayToolCall, taskId: string): boolean {
  return tool.metadata?.background === true && tool.metadata?.taskId === taskId;
}

function displayStatus(task: BackgroundTaskInfo): NonNullable<DisplayToolCall["status"]> {
  return task.status === "killed" ? "cancelled" : task.status === "failed" ? "failed" : "completed";
}

/** Returns a copy of `tool` carrying the task's terminal state. */
export function applyTaskLifecycleToTool(
  tool: DisplayToolCall,
  task: BackgroundTaskInfo,
  output?: string,
): DisplayToolCall {
  return {
    ...tool,
    status: displayStatus(task),
    isError: task.status === "failed",
    result: output?.trim() ? output : tool.result,
    startedAt: task.startedAt ?? tool.startedAt,
    metadata: {
      ...tool.metadata,
      kind: "shell",
      background: true,
      taskId: task.id,
      taskLifecycle: task.status,
      exitCode: task.exitCode ?? null,
      endedAt: task.endedAt,
      outputLines: task.outputLines,
    },
  };
}

/**
 * Lands the terminal state on a launch row that is still in the streaming
 * accumulator. Mutates in place because the accumulator's parts share the
 * same tool objects. A row whose tool_end has not arrived yet is skipped:
 * the reducer would overwrite the merge when the result lands.
 */
export function mergeTaskLifecycleIntoLiveTools(
  tools: DisplayToolCall[],
  task: BackgroundTaskInfo,
  output?: string,
): boolean {
  const tool = tools.find((candidate) => isLaunchRowFor(candidate, task.id));
  if (!tool || tool.status === "running") return false;
  Object.assign(tool, applyTaskLifecycleToTool(tool, task, output));
  return true;
}

/** Lands the terminal state on the committed launch row, if there is one. */
export function applyTaskLifecycleToMessages(
  messages: DisplayMessage[],
  task: BackgroundTaskInfo,
  output?: string,
): { messages: DisplayMessage[]; merged: boolean } {
  const next = mapTranscriptTools(messages, (tool) =>
    isLaunchRowFor(tool, task.id) ? applyTaskLifecycleToTool(tool, task, output) : tool);
  return { messages: next, merged: next !== messages };
}

/** Detached terminal row for a task whose launch row is not in the transcript. */
export function taskLifecycleDisplayMessage(task: BackgroundTaskInfo, output?: string): DisplayMessage {
  const tool = applyTaskLifecycleToTool({
    id: `task-lifecycle:${task.id}:${task.endedAt ?? Date.now()}`,
    name: "bash",
    args: {
      command: task.command,
      ...(task.description ? { description: task.description } : {}),
    },
    startedAt: task.startedAt,
  }, task, output);
  return {
    key: nextDisplayMessageKey("task"),
    role: "assistant",
    content: "",
    toolCalls: [tool],
    parts: [{ type: "tools", toolCalls: [tool] }],
  };
}

/**
 * Lands every terminal state on its launch row; tasks without one get a
 * detached row appended in the given order.
 */
export function landTaskLifecycles(messages: DisplayMessage[], terminals: TaskLifecycleTerminal[]): DisplayMessage[] {
  let next = messages;
  const detached: DisplayMessage[] = [];
  for (const { task, output } of terminals) {
    const landed = applyTaskLifecycleToMessages(next, task, output);
    if (landed.merged) next = landed.messages;
    else detached.push(taskLifecycleDisplayMessage(task, output));
  }
  return detached.length > 0 ? [...next, ...detached] : next;
}
