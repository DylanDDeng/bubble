/*
 * TurnMapper — pure, testable mapping of one Bubble agent turn (a sequence of
 * AgentEvents) into coworker's ServerEvent stream. Kept free of Electron/core
 * imports so it can be unit-tested headlessly with synthetic events.
 *
 * Mapping (matches coworker useAppStore.handleStreamMessage semantics):
 *   text_delta      -> stream_event content_block_delta (text_delta)   [live]
 *   reasoning_delta -> stream_event content_block_delta (thinking_delta)
 *   tool_start      -> finalize streamed text, push tool_use, emit assistant(uuid, streaming)
 *   tool_end        -> user message with a tool_result block
 *   todos_updated   -> plan_update (stable uuid per turn -> replaces in store)
 *   turn_end        -> finalize assistant message (streaming:false)
 */
import { randomUUID } from 'node:crypto';
import type { ServerEvent, StreamMessage, ContentBlock, PlanStep } from '../shared/types';

/** Minimal structural shape of the Bubble AgentEvents we consume. */
export interface MapperAgentEvent {
  type: string;
  content?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: { content?: unknown; isError?: boolean };
  todos?: Array<{ content?: string; status?: string; activeForm?: string }>;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  willContinue?: boolean;
}

export class TurnMapper {
  private assistantUuid: string;
  private planUuid: string;
  private content: ContentBlock[] = [];
  private textBuf = '';

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ServerEvent) => void,
    private readonly uuidFn: () => string = randomUUID,
  ) {
    this.assistantUuid = uuidFn();
    this.planUuid = uuidFn();
  }

  private newTurn(): void {
    this.assistantUuid = this.uuidFn();
    this.content = [];
    this.textBuf = '';
  }

  private flushText(): void {
    if (this.textBuf) {
      this.content.push({ type: 'text', text: this.textBuf });
      this.textBuf = '';
    }
  }

  private emitAssistant(streaming: boolean): void {
    const message: StreamMessage = {
      type: 'assistant',
      uuid: this.assistantUuid,
      message: { content: [...this.content] },
      streaming,
    };
    this.emit({ type: 'stream.message', payload: { sessionId: this.sessionId, message } });
  }

  /** Feed one AgentEvent; emits zero or more ServerEvents. */
  handle(event: MapperAgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.newTurn();
        return;
      case 'text_delta':
        this.textBuf += event.content ?? '';
        this.emit({
          type: 'stream.message',
          payload: {
            sessionId: this.sessionId,
            message: {
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: event.content ?? '' } },
            },
          },
        });
        return;
      case 'reasoning_delta':
        this.emit({
          type: 'stream.message',
          payload: {
            sessionId: this.sessionId,
            message: {
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: event.content ?? '' } },
            },
          },
        });
        return;
      case 'tool_start':
        this.flushText();
        this.emit({
          type: 'stream.message',
          payload: { sessionId: this.sessionId, message: { type: 'stream_event', event: { type: 'content_block_stop' } } },
        });
        this.content.push({ type: 'tool_use', id: event.id ?? '', name: event.name ?? '', input: event.args ?? {} });
        this.emitAssistant(true);
        return;
      case 'tool_end': {
        const result = event.result;
        const message: StreamMessage = {
          type: 'user',
          uuid: this.uuidFn(),
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.id ?? '',
                content: typeof result?.content === 'string' ? result.content : String(result?.content ?? ''),
                is_error: result?.isError,
              },
            ],
          },
        };
        this.emit({ type: 'stream.message', payload: { sessionId: this.sessionId, message } });
        return;
      }
      case 'todos_updated': {
        const steps: PlanStep[] = (event.todos ?? []).map((t) => ({
          step: t.content || t.activeForm || '',
          status: t.status === 'in_progress' ? 'inProgress' : t.status === 'completed' ? 'completed' : 'pending',
        }));
        const message: StreamMessage = {
          type: 'plan_update',
          uuid: this.planUuid,
          turnId: this.assistantUuid,
          steps,
        };
        this.emit({ type: 'stream.message', payload: { sessionId: this.sessionId, message } });
        return;
      }
      case 'turn_end':
        this.flushText();
        this.emitAssistant(false);
        if (event.usage && event.willContinue !== true) {
          this.emit({
            type: 'stream.message',
            payload: {
              sessionId: this.sessionId,
              message: {
                type: 'result',
                subtype: 'success',
                duration_ms: 0,
                total_cost_usd: 0,
                usage: {
                  input_tokens: event.usage.promptTokens ?? 0,
                  output_tokens: event.usage.completionTokens ?? 0,
                },
              },
            },
          });
        }
        return;
      default:
        return;
    }
  }

  /** Flush any trailing buffered text/blocks if the run ended without turn_end. */
  finish(): void {
    if (this.textBuf || this.content.length > 0) {
      this.flushText();
      this.emitAssistant(false);
    }
  }
}
