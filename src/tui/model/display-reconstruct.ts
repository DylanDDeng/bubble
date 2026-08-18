/**
 * Rebuilds UI DisplayMessages from the agent's raw transcript — used on
 * initial mount and after transcript rewrites (rewind, resume).
 */
import { INTERRUPTED_ASSISTANT_CONTENT } from "../../agent.js";
import { isHiddenToolMetadata } from "../../agent/tool-visibility.js";
import { isInternalBlockOnlyContent } from "../../agent/internal-reminder-sanitizer.js";
import { nextDisplayMessageKey, stripInterruptedAssistantMarker, type DisplayMessage, type DisplayToolCall } from "./display-history.js";
import type { Message } from "../../types.js";

export function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const m of agentMessages) {
    if (m.role === "system" || m.role === "tool") continue;
    if (m.role === "user") {
      if ((m as { isMeta?: boolean }).isMeta) continue; // <system-reminder> injections are not user-visible
      // Harness-initiated kicks (goal continuations, task wakes) persist as
      // user-role messages wrapped in internal blocks so the model keeps
      // them across resume — but they were hidden live and must stay hidden
      // when the transcript is rebuilt.
      if (isInternalBlockOnlyContent(m.content)) continue;
      result.push({
        key: nextDisplayMessageKey("user"),
        role: "user",
        content: typeof m.content === "string" ? m.content : "(multimedia)",
      });
    } else if (m.role === "assistant") {
      const toolCalls: DisplayToolCall[] = [];
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.arguments || "{}") as Record<string, any>;
          } catch {
            args = {};
          }
          const toolResult = agentMessages.find(
            (tm) => tm.role === "tool" && (tm as any).toolCallId === tc.id
          );
          if (isHiddenToolMetadata(toolResult ? (toolResult as any).metadata : undefined)) continue;
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: toolResult ? (toolResult as any).content as string : undefined,
            isError: toolResult ? (toolResult as any).content?.startsWith?.("Error:") : false,
            metadata: toolResult ? (toolResult as any).metadata : undefined,
          });
        }
      }
      // An aborted assistant message carries the model-facing interruption
      // note in its content. Render only what the assistant actually said
      // (partial streamed text, if any) plus a dedicated interrupt row —
      // never the note itself, which reads like a leaked system prompt.
      const interrupted = (m as { error?: { aborted?: boolean } }).error?.aborted === true;
      const content = interrupted
        ? stripInterruptedAssistantMarker(m.content, INTERRUPTED_ASSISTANT_CONTENT)
        : m.content;
      if (content || m.reasoning || toolCalls.length > 0 || m.systemFingerprint) {
        result.push({
          key: nextDisplayMessageKey("asst"),
          role: "assistant",
          content,
          reasoning: m.reasoning || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          systemFingerprint: m.systemFingerprint,
        });
      }
      if (interrupted) {
        result.push({
          key: nextDisplayMessageKey("asst"),
          role: "assistant",
          content: "Interrupted by user",
          syntheticKind: "ui_interrupt",
        });
      }
    }
  }
  return result;
}
