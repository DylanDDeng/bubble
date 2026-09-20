import type { BubbleSubagentState, StreamMessage } from '../../shared/types';
import type { ToolStatus } from '../types';
import { getMessageContentBlocks, normalizeToolUseBlock, normalizeToolResultBlock } from './message-content';

export const childControlTools = new Set(['wait_agent', 'send_input', 'close_agent']);
export function controlAgentIds(name: string, input: unknown): string[] {
  if (!childControlTools.has(name) || !input || typeof input !== 'object') return [];
  const args = input as Record<string, unknown>;
  return [...new Set([args.agent_id, ...(Array.isArray(args.agent_ids) ? args.agent_ids : [])]
    .filter((id): id is string => typeof id === 'string' && !!id.trim()))];
}
export function latestChildState(messages: StreamMessage[]): BubbleSubagentState | undefined {
  return messages.reduce<BubbleSubagentState | undefined>((last, message) => {
    const state = message.bubbleSubagent;
    return state && (!last || state.updatedAt >= last.updatedAt) ? state : last;
  }, undefined);
}
export function childToolStatus(state: BubbleSubagentState, active: boolean): ToolStatus {
  if (state.status === 'completed') return 'success';
  if (state.status === 'failed' || state.status === 'blocked') return 'error';
  if (state.status === 'closed' || state.status === 'cancelled' || !active) return 'interrupted';
  return 'pending';
}
export function shortChildTask(task: string): string {
  let first = task.split(/\n|。/)[0].replace(/(?:\/[\w.~-]+){2,}/g, path => path.split('/').pop() || path).trim();
  const issue = first.match(/(?:GitHub\s*)?issue\s*#\d+/i);
  if (issue) first = `${issue[0].replace(/^GitHub\s*/i, '')} · ${first.replace(issue[0], '').replace(/的\s*$/, '').trim()}`;
  return first.length > 64 ? `${first.slice(0, 63)}…` : first;
}
export interface ChildOperation { id: string; label: string; detail: string; pending: boolean; failed: boolean }
export function childOperations(messages: StreamMessage[]): ChildOperation[] {
  const results = new Map<string, ReturnType<typeof normalizeToolResultBlock>>();
  for (const message of messages) for (const block of getMessageContentBlocks(message)) {
    const result = normalizeToolResultBlock(block);
    if (result) results.set(result.tool_use_id, result);
  }
  const operations: ChildOperation[] = [];
  for (const message of messages) for (const block of getMessageContentBlocks(message)) {
    const tool = normalizeToolUseBlock(block);
    if (!tool || !childControlTools.has(tool.name)) continue;
    const result = results.get(tool.id);
    const pending = !result;
    const failed = !!result?.is_error;
    const args = tool.input as Record<string, unknown>;
    const label = tool.name === 'wait_agent'
      ? (failed ? 'Could not wait for subagent' : pending ? 'Main agent is waiting for this subagent' : 'Wait finished')
      : tool.name === 'close_agent' ? (failed ? 'Could not stop subagent' : pending ? 'Stopping subagent' : 'Subagent stopped')
      : failed ? 'Supplementary message not delivered'
      : pending ? 'Sending supplementary message' : args?.interrupt ? 'Task redirected' : 'Supplementary message accepted';
    operations.push({ id: tool.id, label, pending, failed,
      detail: JSON.stringify({ tool: tool.name, input: tool.input, result: result?.content }, null, 2) });
  }
  return operations;
}
