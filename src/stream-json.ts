/** Persistent headless transport. One Agent + MCP lifecycle, sequential user turns. */
import type { Readable } from "node:stream";
import { PrintRunCollector } from "./print-output.js";
import type { AgentEvent } from "./types.js";

interface StreamSessionOptions {
  input: Readable;
  write: (message: Record<string, unknown>) => void;
  sessionId: string;
  model: string;
  run: (prompt: string) => AsyncIterable<AgentEvent>;
  onEvent?: (event: AgentEvent) => void;
}

const maxLineBytes = 1024 * 1024;
async function* lines(input: Readable): AsyncGenerator<string> {
  input.setEncoding("utf8");
  let pending = "";
  for await (const chunk of input) {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error("Input line exceeds 1 MiB");
      if (line.trim()) yield line;
    }
    if (Buffer.byteLength(pending) > maxLineBytes) throw new Error("Input line exceeds 1 MiB");
  }
  if (pending.trim()) yield pending;
}

function userText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.length && value.every(item =>
    item && item.type === "text" && typeof item.text === "string")) {
    const text = value.map(item => item.text).join("\n");
    if (text.trim()) return text;
  }
  throw new Error("message.content must be non-empty text or text blocks");
}

export async function runStreamJsonSession(options: StreamSessionOptions): Promise<void> {
  const { write, sessionId, model } = options;
  write({ type: "system", subtype: "init", session_id: sessionId, model, protocol_version: 1 });
  let sequence = 0;
  // Read only as turns finish: the stream's own backpressure bounds queued input.
  // EOF drains all accepted messages before main() shuts down MCP and the Agent.
  for await (const line of lines(options.input)) {
    let requestId: string | undefined;
    let prompt: string;
    try {
      const message = JSON.parse(line);
      if (typeof message?.request_id === "string") requestId = message.request_id;
      if (message?.type !== "user" || message.message?.role !== "user") {
        throw new Error('Expected {type:"user",message:{role:"user",content:"..."}}');
      }
      if (message.session_id && message.session_id !== sessionId) throw new Error("Session ID does not match this process");
      prompt = userText(message.message.content);
    } catch (error) {
      write({ type: "result", is_error: true, subtype: "invalid_input", session_id: sessionId,
        request_id: requestId, result: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const collector = new PrintRunCollector();
    const envelope = { session_id: sessionId, request_id: requestId, turn: ++sequence };
    try {
      for await (const event of options.run(prompt)) {
        collector.onEvent(event);
        options.onEvent?.(event);
        write({ type: "stream_event", ...envelope, event });
      }
      const summary = collector.summary();
      write({ type: "result", ...envelope, is_error: false, result: summary.text, stopReason: "end_turn", ...summary });
    } catch (error) {
      write({ type: "result", ...envelope, is_error: true, stopReason: "error", ...collector.summary(),
        result: error instanceof Error ? error.message : String(error) });
    }
  }
}
