import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { StreamMessage } from '../../shared/types';
import type { SessionRow } from '../types';
import { resolveBubbleHome } from './bubble-home';

const MAX_LOG_BYTES = 64 * 1024 * 1024;
const normalizeModel = (model: string) => model.trim().toLowerCase();
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Read-only compatibility for sessions created before context telemetry existed.
 * No SDK initialization, provider calls, history migration or credential access.
 */
export async function recoverBubbleHistoryContext(
  session: SessionRow,
  messages: StreamMessage[],
): Promise<StreamMessage | null> {
  if (session.provider !== 'bubble' || !session.cwd || !session.bubble_session_id ||
      !['idle', 'completed', 'stopped', 'error'].includes(session.status)) return null;
  // Even a null snapshot is authoritative (e.g. manual compaction invalidation).
  if (messages.some(m => !m.parentToolUseId && m.type === 'system' && m.subtype === 'bubble_context')) return null;
  const nativeId = session.bubble_session_id;
  if (nativeId === '.' || nativeId === '..' || /[/\\\0]/.test(nativeId)) return null;
  const file = join(resolveBubbleHome(), 'sessions', session.cwd.replace(/[/\\:]/g, '_'),
    nativeId.endsWith('.jsonl') ? nativeId : `${nativeId}.jsonl`);
  let handle;
  let stream: ReadStream | undefined;
  try {
    handle = await open(file, 'r');
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_LOG_BYTES) return null;
    let metadataModel = '';
    let boundary = -1;
    let latest: { id: string; timestamp: number; model: string; usedTokens: number } | null = null;
    stream = handle.createReadStream({ autoClose: false });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        // Fail closed on partial/corrupt records; never resurrect an earlier usage.
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || !nonnegative(entry.timestamp)) return null;
        if (entry.type === 'metadata') {
          if (entry.metadata?.externalRuntime) return null;
          if (typeof entry.metadata?.model === 'string') metadataModel = entry.metadata.model;
        }
        const message = entry.type === 'message' ? entry.data : entry.message;
        if (entry.type === 'summary' || entry.type === 'compaction' ||
            (entry.type === 'message' && message?.role === 'system') ||
            (entry.type === 'marker' && ['conversation_clear', 'model_switch', 'provider_switch', 'runtime_switch'].includes(entry.kind))) {
          // Compaction rewrites summary BEFORE retained messages. Their file order
          // does not imply that their usage was measured after compaction.
          boundary = Math.max(boundary, entry.timestamp);
        }
        if (entry.type === 'user_message' || (entry.type === 'message' && message?.role === 'user')) latest = null;
        if (entry.type !== 'assistant_message' && !(entry.type === 'message' && message?.role === 'assistant')) continue;
        latest = null;
        const usage = message?.usage;
        if (!nonnegative(usage?.promptTokens) || !nonnegative(usage?.completionTokens)) continue;
        let model = typeof message.model === 'string' ? message.model : metadataModel;
        if (typeof message.providerId === 'string' && typeof message.modelId === 'string') model = `${message.providerId}:${message.modelId}`;
        const usedTokens = usage.promptTokens + usage.completionTokens;
        if (!Number.isFinite(usedTokens)) continue;
        latest = { id: String(entry.id), timestamp: entry.timestamp, model, usedTokens };
      }
    } finally {
      lines.close();
    }
    const after = await stat(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    if (!latest || latest.timestamp <= boundary || !latest.model ||
        (session.model && normalizeModel(latest.model) !== normalizeModel(session.model))) return null;
    // The old result's window is useful; its cumulative token count is not.
    const result = [...messages].reverse().find(m => !m.parentToolUseId && m.type === 'result' &&
      normalizeModel(m.model || '') === normalizeModel(latest!.model) &&
      nonnegative(m.usage?.context_window) && m.usage!.context_window! > 0);
    const contextWindow = result?.type === 'result' ? result.usage?.context_window : undefined;
    if (!contextWindow) return null;
    const key = createHash('sha256').update(JSON.stringify([session.id, nativeId, latest, contextWindow])).digest('hex').slice(0, 24);
    return { type: 'system', subtype: 'bubble_context', uuid: `bubble-history-context-${key}`,
      createdAt: latest.timestamp, model: latest.model,
      context: { usedTokens: latest.usedTokens, contextWindow, estimated: false } };
  } catch {
    // Missing native logs or unsupported history must not prevent opening chat.
    return null;
  } finally {
    stream?.destroy();
    await handle?.close();
  }
}
