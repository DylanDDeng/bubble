import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import { GrokRuntimeError } from "./grok-errors.js";

export const GROK_ACP_MAX_LINE_BYTES = 1024 * 1024;

export interface BoundedNdjsonOptions {
  maxLineBytes?: number;
  onProtocolError?: (error: GrokRuntimeError) => void;
  /** Return true to consume a validated envelope before SDK async dispatch. */
  interceptIncoming?: (message: AnyMessage) => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): boolean {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (typeof value.method === "string" && value.method.length > 0) {
    return !("id" in value) || isJsonRpcId(value.id);
  }
  if (!("id" in value) || !isJsonRpcId(value.id)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasResult === hasError) return false;
  if (hasError) {
    return isRecord(value.error)
      && typeof value.error.code === "number"
      && typeof value.error.message === "string";
  }
  return true;
}

function malformedMessage(): GrokRuntimeError {
  return new GrokRuntimeError("protocol_error", "Grok ACP sent a malformed JSON-RPC message.");
}

function oversizedMessage(): GrokRuntimeError {
  return new GrokRuntimeError("protocol_error", "Grok ACP message exceeded the safe line limit.");
}

/**
 * A credential-safe NDJSON transport. Unlike the SDK convenience transport,
 * this implementation bounds each line and never prints rejected input.
 */
export function createBoundedGrokNdjsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: BoundedNdjsonOptions = {},
): Stream {
  const maxLineBytes = options.maxLineBytes ?? GROK_ACP_MAX_LINE_BYTES;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let inputReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let reported = false;
  const pendingRequestIds = new Set<string>();
  const requestKey = (id: unknown) => `${typeof id}:${String(id)}`;

  const report = (error: GrokRuntimeError) => {
    if (reported) return;
    reported = true;
    options.onProtocolError?.(error);
  };

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const parts: Uint8Array[] = [];
      let lineBytes = 0;
      const append = (segment: Uint8Array) => {
        if (lineBytes + segment.byteLength > maxLineBytes) throw oversizedMessage();
        if (segment.byteLength > 0) parts.push(new Uint8Array(segment));
        lineBytes += segment.byteLength;
      };
      const consumeLine = () => {
        if (lineBytes === 0) return;
        const bytes = new Uint8Array(lineBytes);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        parts.length = 0;
        lineBytes = 0;
        let text: string;
        try {
          text = decoder.decode(bytes).trim();
        } catch {
          throw malformedMessage();
        }
        if (!text) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw malformedMessage();
        }
        if (!isJsonRpcMessage(parsed)) throw malformedMessage();
        if (!("method" in parsed)) {
          // The pinned CLI emits a small number of internal responses (for
          // example `skills-reload`) that were never requested by Bubble. The
          // SDK logs unknown response IDs verbatim, so consume them here unless
          // the ID belongs to an outgoing Bubble request.
          if (!pendingRequestIds.delete(requestKey(parsed.id))) return;
        }
        if (options.interceptIncoming?.(parsed)) return;
        controller.enqueue(parsed);
      };

      const reader = input.getReader();
      inputReader = reader;
      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          let start = 0;
          for (let index = 0; index < value.byteLength; index += 1) {
            if (value[index] !== 0x0a) continue;
            append(value.subarray(start, index));
            consumeLine();
            start = index + 1;
          }
          if (start < value.byteLength) append(value.subarray(start));
        }
        if (!cancelled && lineBytes > 0) consumeLine();
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) {
          const safe = error instanceof GrokRuntimeError ? error : malformedMessage();
          report(safe);
          await reader.cancel(safe).catch(() => undefined);
          // The typed failure is delivered through onProtocolError. Close the
          // SDK-facing stream cleanly so its router never logs the rejected raw
          // JSON-RPC line as part of an exception path.
          try {
            controller.close();
          } catch {
            // The connection may have been concurrently closed by the
            // protocol-error callback. Either state is safely terminal.
          }
        }
      } finally {
        if (inputReader === reader) inputReader = undefined;
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await inputReader?.cancel(reason);
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      let bytes: Uint8Array;
      try {
        bytes = encoder.encode(`${JSON.stringify(message)}\n`);
      } catch {
        const error = malformedMessage();
        report(error);
        throw error;
      }
      if (bytes.byteLength > maxLineBytes) {
        const error = oversizedMessage();
        report(error);
        throw error;
      }
      if ("method" in message && "id" in message) {
        pendingRequestIds.add(requestKey(message.id));
      }
      const writer = output.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        writer.releaseLock();
      }
    },
    async abort(reason) {
      await output.abort(reason);
    },
    async close() {
      await output.close();
    },
  });

  return { readable, writable };
}
