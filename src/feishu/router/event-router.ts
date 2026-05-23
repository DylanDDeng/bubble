/**
 * Top-level inbound dispatcher.
 *
 * Wires `channel.onMessage` and `channel.onCardAction` to:
 *   - run the three whitelist gates
 *   - dispatch slash commands (sync, no agent)
 *   - hand normal text to the PendingQueue (which eventually fires the
 *     RunDriver via the flush callback)
 *   - route cardAction events to the approval UI or stop-button handler
 */

import type { BubbleChannel, NormalizedMessage, CardActionEvent } from "../channel/channel.js";
import { dispatchCommand, isSlashCommand, type CommandContext } from "./commands.js";
import { checkWhitelist } from "./whitelist.js";
import type { ScopeRegistry } from "../scope/scope-registry.js";
import type { SessionStore } from "../scope/session-store.js";
import type { ActiveRuns } from "../runtime/active-runs.js";
import type { PendingQueue } from "../runtime/pending-queue.js";
import type { FeishuApprovalUI } from "../agent-host/approval-ui.js";
import type { FeishuLogger } from "../logger.js";
import { makeScopeKey } from "../types.js";

export interface EventRouterOptions {
  channel: BubbleChannel;
  scopeRegistry: ScopeRegistry;
  sessionStore: SessionStore;
  activeRuns: ActiveRuns;
  pendingQueue: PendingQueue;
  approvalUI: FeishuApprovalUI;
  logger: FeishuLogger;
  commandContext: CommandContext;
  requireMentionInGroup: boolean;
}

export class EventRouter {
  private unsubMessage?: () => void;
  private unsubCardAction?: () => void;
  private unsubReject?: () => void;

  constructor(private readonly opts: EventRouterOptions) {}

  start(): void {
    this.unsubMessage = this.opts.channel.onMessage(async (msg) => {
      this.opts.logger.info("message_received", {
        phase: "router",
        chatId: msg.chatId,
        userId: msg.senderId,
        messageId: msg.messageId,
        chatType: msg.chatType,
        contentType: msg.rawContentType,
        mentionedBot: msg.mentionedBot,
      });
      try {
        await this.handleMessage(msg);
      } catch (err) {
        this.opts.logger.error("router_message_error", {
          phase: "router",
          chatId: msg.chatId,
          userId: msg.senderId,
          error: serializeError(err),
        });
      }
    });

    this.unsubCardAction = this.opts.channel.onCardAction(async (evt) => {
      try {
        await this.handleCardAction(evt);
      } catch (err) {
        this.opts.logger.error("router_card_action_error", {
          phase: "router",
          chatId: evt.chatId,
          error: serializeError(err),
        });
      }
    });

    // Subscribe to SDK-level policy rejects so we can see if messages are
    // being dropped before reaching our handler.
    this.unsubReject = this.opts.channel.onReject((evt) => {
      this.opts.logger.warn("sdk_reject", {
        phase: "channel",
        chatId: evt.chatId,
        userId: evt.senderId,
        messageId: evt.messageId,
        reason: evt.reason,
      });
    });
  }

  stop(): void {
    this.unsubMessage?.();
    this.unsubCardAction?.();
    this.unsubReject?.();
  }

  private async handleMessage(msg: NormalizedMessage): Promise<void> {
    // Only text messages are processed in v1.
    if (msg.rawContentType !== "text") {
      this.opts.logger.debug("skip_non_text", {
        phase: "router",
        chatId: msg.chatId,
        userId: msg.senderId,
        kind: msg.rawContentType,
      });
      return;
    }

    // LarkChannel already normalizes text out of the raw `{"text":"..."}`
    // JSON wrapper, so msg.content is the plain string we want.
    const text = msg.content ?? "";
    if (!text.trim()) {
      this.opts.logger.debug("skip_empty_text", {
        phase: "router",
        chatId: msg.chatId,
        userId: msg.senderId,
      });
      return;
    }

    const scope = this.opts.scopeRegistry.get(msg.chatId);

    // Get chat mode from event (normalized to p2p/group; topic must be detected via getChatMode)
    let chatMode: "p2p" | "group" | "topic" = msg.chatType;
    if (msg.chatType === "group") {
      // Cheap check: if event already says group, fetch chat mode to detect topic.
      try {
        chatMode = await this.opts.channel.getChatMode(msg.chatId);
      } catch {
        // Default to group if API call fails.
        chatMode = "group";
      }
    }

    const gate = checkWhitelist({
      chatId: msg.chatId,
      userId: msg.senderId,
      chatType: chatMode,
      mentionedBot: msg.mentionedBot,
      scope,
      requireMentionInGroup: this.opts.requireMentionInGroup,
    });
    if (!gate.ok) {
      this.opts.logger.info("gate_rejected", {
        phase: "router",
        chatId: msg.chatId,
        userId: msg.senderId,
        reason: gate.reason,
      });
      // topic_chat is the one case where we DO reply, to help the user — they
      // configured the chat but can't use it.
      if (gate.reason === "topic_chat_unsupported") {
        await this.opts.channel.send(msg.chatId, {
          text: "⚠️ 暂不支持话题群，请用普通群或私聊。",
        });
      }
      return;
    }
    if (!scope) return; // unreachable (gate.ok implies scope exists)

    const scopeKey = makeScopeKey(msg.chatId, msg.senderId);
    const cleanText = stripBotMention(text);

    // Slash command?
    if (isSlashCommand(cleanText)) {
      await dispatchCommand(
        {
          chatId: msg.chatId,
          userId: msg.senderId,
          scope,
          scopeKey,
          raw: cleanText,
          replyTo: msg.messageId,
        },
        this.opts.commandContext,
      );
      this.opts.scopeRegistry.touch(msg.chatId);
      return;
    }

    // Normal agent prompt — push to queue.
    this.opts.pendingQueue.push(scopeKey, {
      text: cleanText,
      messageId: msg.messageId,
      receivedAt: Date.now(),
    });
    this.opts.scopeRegistry.touch(msg.chatId);
  }

  private async handleCardAction(evt: CardActionEvent): Promise<void> {
    const value = evt.action.value as Record<string, unknown> | null | undefined;
    if (!value || typeof value !== "object") return;

    // Approval card button.
    if (value.__bubble === "approval") {
      await this.opts.approvalUI.dispatch({
        cardMessageId: evt.messageId,
        clickerOpenId: evt.operator.openId,
        value,
      });
      return;
    }

    // Stop button on the run-state card.
    if (value.__bubble === "stop_run") {
      const scope = this.opts.scopeRegistry.get(evt.chatId);
      if (!scope) return;
      if (!scope.allowedUsers.includes(evt.operator.openId)) return;
      const scopeKey = makeScopeKey(evt.chatId, evt.operator.openId);
      this.opts.activeRuns.abort(scopeKey);
      this.opts.logger.info("stop_button_clicked", {
        phase: "router",
        chatId: evt.chatId,
        userId: evt.operator.openId,
      });
      return;
    }

    // Unknown button — log and ignore.
    this.opts.logger.debug("unknown_card_action", {
      phase: "router",
      chatId: evt.chatId,
      value: JSON.stringify(value),
    });
  }
}

/**
 * Strip leading `@_user_X` or `@bot` tokens that Feishu injects when the
 * user @-mentions the bot. Specific tokens vary by tenant; a generic
 * pattern handles the common cases.
 */
function stripBotMention(text: string): string {
  return text.replace(/^@[\w_]+\s+/g, "").trim();
}

function serializeError(err: unknown): { message: string; name?: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}
