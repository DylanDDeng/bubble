/**
 * Thin wrapper around `LarkChannel` from @larksuiteoapi/node-sdk.
 *
 * We don't add much behavior — just provide a stable, mockable surface for
 * the rest of the Feishu host. Tests construct a `MockBubbleChannel` that
 * implements the same interface without touching real network.
 */

import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
  type LarkChannelOptions,
  type NormalizedMessage,
  type CardActionEvent,
  type RejectEvent,
  type SendResult,
  type SendOptions,
  type WSConnectionStatus,
} from "@larksuiteoapi/node-sdk";

export type { NormalizedMessage, CardActionEvent };

export interface BubbleChannelOptions {
  appId: string;
  appSecret: string;
  /** Forwarded to LarkChannelOptions.outbound.streamThrottleMs. */
  outputThrottleMs?: number;
  /**
   * If true (default), group messages require @bot mention before being
   * forwarded. Note: this is enforced at the LarkChannel policy layer; the
   * router applies the per-scope `requireMentionInGroup` setting on top.
   */
  requireMentionInGroup?: boolean;
}

export interface BubbleChannel {
  /** Resolve once the WebSocket has handshaken at least once. */
  connect(): Promise<void>;
  /** Close cleanly. */
  disconnect(): Promise<void>;
  /** Connection-status snapshot, for /status / /doctor commands. */
  getStatus(): WSConnectionStatus | undefined;

  /** Send a one-off message (text, card, etc.) — see SDK SendInput. */
  send(chatId: string, input: SendInput, opts?: SendOptions): Promise<SendResult>;

  /** Patch an already-sent card. */
  updateCard(messageId: string, card: object): Promise<void>;

  /**
   * Open a streaming card; producer is given a controller with `update()`.
   * The SDK handles throttling and the 30KB element auto-rollover.
   */
  stream(chatId: string, input: StreamInput, opts?: SendOptions): Promise<SendResult>;

  /** Event subscriptions. Returned function unsubscribes. */
  onMessage(handler: (msg: NormalizedMessage) => void | Promise<void>): () => void;
  onCardAction(handler: (evt: CardActionEvent) => void | Promise<void>): () => void;
  onReject(handler: (evt: RejectEvent) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  onReconnecting(handler: () => void): () => void;
  onReconnected(handler: () => void): () => void;

  /** Fetch the chat's mode (cached by callers, not by us). */
  getChatMode(chatId: string): Promise<"p2p" | "group" | "topic">;

  /** Reveal the bot's own open_id once connected. Useful for self-mention checks. */
  botOpenId(): string | undefined;
}

export type SendInput = Parameters<LarkChannel["send"]>[1];
export type StreamInput = Parameters<LarkChannel["stream"]>[1];

export function createBubbleChannel(opts: BubbleChannelOptions): BubbleChannel {
  const verbose = process.env.BUBBLE_FEISHU_DEBUG === "1";
  const sdkOpts: LarkChannelOptions = {
    appId: opts.appId,
    appSecret: opts.appSecret,
    transport: "websocket",
    loggerLevel: verbose ? LoggerLevel.debug : LoggerLevel.warn,
    includeRawEvent: verbose,
    outbound: {
      streamThrottleMs: opts.outputThrottleMs ?? 400,
    },
    policy: {
      // Bubble enforces mention/whitelist itself in the router. Keep the
      // SDK's policy layer permissive so we can give cleaner error
      // feedback than a silent SDK-side reject.
      dmMode: "open",
      requireMention: false,
      respondToMentionAll: false,
    },
  };

  const inner = createLarkChannel(sdkOpts);

  return {
    async connect() {
      await inner.connect();
    },
    async disconnect() {
      await inner.disconnect();
    },
    getStatus() {
      return inner.getConnectionStatus();
    },
    async send(chatId, input, opts) {
      return inner.send(chatId, input, opts);
    },
    async updateCard(messageId, card) {
      return inner.updateCard(messageId, card);
    },
    async stream(chatId, input, opts) {
      return inner.stream(chatId, input, opts);
    },
    onMessage(handler) {
      return inner.on("message", handler);
    },
    onCardAction(handler) {
      return inner.on("cardAction", handler);
    },
    onReject(handler) {
      return inner.on("reject", handler);
    },
    onError(handler) {
      return inner.on("error", handler);
    },
    onReconnecting(handler) {
      return inner.on("reconnecting", handler);
    },
    onReconnected(handler) {
      return inner.on("reconnected", handler);
    },
    async getChatMode(chatId) {
      return inner.getChatMode(chatId);
    },
    botOpenId() {
      return inner.botIdentity?.openId;
    },
  };
}
