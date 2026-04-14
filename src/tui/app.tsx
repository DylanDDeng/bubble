import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Agent } from "../agent.js";
import type { CliArgs } from "../cli.js";
import type { SessionManager } from "../session.js";
import type { AgentEvent, Message } from "../types.js";
import { registry as slashRegistry } from "../slash-commands/index.js";
import { InputBox } from "./input-box.js";
import { MessageList, type DisplayMessage, type DisplayToolCall } from "./message-list.js";

interface AppProps {
  agent: Agent;
  args: CliArgs;
  sessionManager?: SessionManager;
}

function reconstructDisplayMessages(agentMessages: Message[]): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (const m of agentMessages) {
    if (m.role === "system" || m.role === "tool") continue;
    if (m.role === "user") {
      result.push({
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
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            args,
            result: toolResult ? (toolResult as any).content as string : undefined,
            isError: toolResult ? (toolResult as any).content?.startsWith?.("Error:") : false,
          });
        }
      }
      result.push({
        role: "assistant",
        content: m.content,
        reasoning: m.reasoning || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }
  return result;
}

export function App({ agent, args, sessionManager }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<DisplayMessage[]>(() => reconstructDisplayMessages(agent.messages));
  const [isRunning, setIsRunning] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingTools, setStreamingTools] = useState<DisplayToolCall[]>([]);

  useInput((_input, key) => {
    if (key.escape) {
      exit();
    }
  });

  const addMessage = useCallback((role: DisplayMessage["role"], content: string) => {
    setMessages((prev) => [...prev, { role, content }]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const handleSubmit = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // Intercept slash commands
      if (input.startsWith("/")) {
        const { handled, result } = await slashRegistry.execute(input, {
          agent,
          addMessage,
          clearMessages,
          exit,
        });
        if (handled) {
          if (result) {
            addMessage("assistant", result);
          }
          return;
        }
      }

      setMessages((prev) => [...prev, { role: "user", content: input }]);
      setIsRunning(true);
      setStreamingContent("");
      setStreamingReasoning("");
      setStreamingTools([]);

      let assistantContent = "";
      let assistantReasoning = "";
      const toolCalls: DisplayToolCall[] = [];

      try {
        for await (const event of agent.run(input, args.cwd)) {
          switch (event.type) {
            case "text_delta":
              assistantContent += event.content;
              setStreamingContent(assistantContent);
              break;
            case "reasoning_delta":
              assistantReasoning += event.content;
              setStreamingReasoning(assistantReasoning);
              break;
            case "tool_start": {
              const tc: DisplayToolCall = {
                id: event.id,
                name: event.name,
                args: event.args,
              };
              toolCalls.push(tc);
              setStreamingTools([...toolCalls]);
              break;
            }
            case "tool_end": {
              const tc = toolCalls.find((t) => t.id === event.id);
              if (tc) {
                tc.result = event.result.content;
                tc.isError = event.result.isError;
                setStreamingTools([...toolCalls]);
              }
              break;
            }
            case "turn_end": {
              const currentContent = assistantContent;
              const currentReasoning = assistantReasoning;
              const currentToolCalls = [...toolCalls];
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role === "assistant") {
                  // Merge into the last assistant message (auto-continue fold)
                  const merged: DisplayMessage = {
                    ...last,
                    reasoning: currentReasoning || last.reasoning,
                    content:
                      last.content && currentContent
                        ? last.content + "\n" + currentContent
                        : last.content + currentContent,
                    toolCalls: [...(last.toolCalls || []), ...currentToolCalls],
                  };
                  return [...prev.slice(0, -1), merged];
                }
                const msg: DisplayMessage = {
                  role: "assistant",
                  content: currentContent,
                };
                if (currentReasoning) {
                  msg.reasoning = currentReasoning;
                }
                if (currentToolCalls.length > 0) {
                  msg.toolCalls = currentToolCalls;
                }
                return [...prev, msg];
              });
              setStreamingContent("");
              setStreamingReasoning("");
              setStreamingTools([]);
              assistantContent = "";
              assistantReasoning = "";
              toolCalls.length = 0;
              break;
            }
          }
        }
      } catch (err: any) {
        setMessages((prev) => [...prev, { role: "error", content: err.message }]);
      } finally {
        setIsRunning(false);
        setStreamingContent("");
        setStreamingReasoning("");
        setStreamingTools([]);
      }
    },
    [agent, args.cwd]
  );

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {messages.length === 0 && !isRunning && (
          <Text dimColor>
            Welcome! Type a message and press Enter. Shift+Enter for new line. Esc to quit.
          </Text>
        )}
        <MessageList
          messages={messages}
          streamingContent={streamingContent}
          streamingReasoning={streamingReasoning}
          streamingTools={streamingTools}
        />
      </Box>
      <Box paddingX={1} paddingBottom={1} flexShrink={0}>
        <InputBox onSubmit={handleSubmit} disabled={isRunning} />
      </Box>
      {sessionManager && (
        <Box paddingX={1}>
          <Text dimColor>Session: {sessionManager.getSessionFile()}</Text>
        </Box>
      )}
    </Box>
  );
}
