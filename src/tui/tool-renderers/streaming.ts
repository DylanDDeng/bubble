import type { DisplayToolCall } from "../display-history.js";
import { parsePartialWriteArgs } from "./write-preview.js";

export function upsertStreamingToolCall(toolCalls: DisplayToolCall[], id: string, name: string, rawArguments: string): DisplayToolCall {
  const args = parseToolArgumentsForDisplay(name, rawArguments, false);
  const existing = toolCalls.find((item) => item.id === id);
  if (existing) {
    existing.name = name;
    existing.args = args;
    existing.rawArguments = rawArguments;
    existing.streamingArgs = true;
    existing.status = existing.status === "running" || existing.status === "completed" || existing.status === "error"
      ? existing.status
      : "pending";
    return existing;
  }
  const call: DisplayToolCall = {
    id,
    name,
    args,
    rawArguments,
    streamingArgs: true,
    status: "pending",
  };
  toolCalls.push(call);
  return call;
}

export function finishStreamingToolCall(toolCalls: DisplayToolCall[], id: string, name: string, rawArguments: string): DisplayToolCall {
  const parsedArgs = parseToolArgumentsForDisplay(name, rawArguments, true);
  const existing = toolCalls.find((item) => item.id === id);
  if (existing) {
    existing.name = name;
    existing.args = parsedArgs;
    existing.rawArguments = rawArguments;
    existing.streamingArgs = false;
    existing.status = "pending";
    return existing;
  }
  const call: DisplayToolCall = {
    id,
    name,
    args: parsedArgs,
    rawArguments,
    streamingArgs: false,
    status: "pending",
  };
  toolCalls.push(call);
  return call;
}

export function parseToolArgumentsForDisplay(name: string, rawArguments: string, complete: boolean): Record<string, unknown> {
  if (complete) {
    try {
      return JSON.parse(rawArguments || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  if (name === "write") {
    return parsePartialWriteArgs(rawArguments);
  }
  return {};
}
