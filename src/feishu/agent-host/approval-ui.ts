/**
 * Feishu-side approval handler.
 *
 * We don't implement ApprovalController ourselves — we reuse the existing
 * `PermissionAwareApprovalController` and provide its `handlerRef.current`,
 * which is the function called when interactive approval is required.
 *
 * That handler:
 *   1. Builds an approval card with [批准] [拒绝] [批准并加入会话允许列表] buttons.
 *   2. Sends the card to the chat (separately from the run-state card).
 *   3. Returns a Promise that resolves when the matching `cardAction` event
 *      arrives (and the clicker is the original user).
 *   4. Times out after `timeoutMs`, rejecting with feedback.
 *
 * Caller responsibilities:
 *   - Wire the LarkChannel `cardAction` listener to call `dispatch(evt)`.
 *   - On scope shutdown, call `cancelAll()` so any pending prompt rejects.
 */

import type { ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import type { BashAllowlist } from "../../approval/session-cache.js";
import { formatApprovalRequest } from "./approval-card.js";

export interface ApprovalUIOptions {
  /** Send a new interactive card to `chatId`, returning the new messageId. */
  sendCard: (chatId: string, card: object) => Promise<{ messageId: string }>;
  /** Update a card in place to reflect the decision. */
  updateCard: (messageId: string, card: object) => Promise<void>;
  /** Session-scoped bash allowlist (shared with the controller). */
  bashAllowlist?: BashAllowlist;
  /** Max time to wait for the user to click. */
  timeoutMs?: number;
}

export interface ApprovalDispatchEvent {
  /** messageId of the card the button is attached to. */
  cardMessageId: string;
  /** open_id of the clicker. */
  clickerOpenId: string;
  /** The button's `value` payload (whatever was set in the card). */
  value: unknown;
}

interface PendingPrompt {
  callbackId: string;
  cardMessageId: string;
  originalUserId: string;
  chatId: string;
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;
let CALLBACK_SEQ = 0;

export class FeishuApprovalUI {
  private pending = new Map<string, PendingPrompt>();

  constructor(private readonly opts: ApprovalUIOptions) {}

  /**
   * Create a handler suitable for `PermissionAwareApprovalController.handlerRef.current`.
   * The handler is closure-bound to (chatId, originalUserId) so each scope
   * gets its own clicker-restricted prompt.
   */
  makeHandler(chatId: string, originalUserId: string): (req: ApprovalRequest) => Promise<ApprovalDecision> {
    return async (req) => this.prompt(chatId, originalUserId, req);
  }

  async prompt(chatId: string, originalUserId: string, req: ApprovalRequest): Promise<ApprovalDecision> {
    const callbackId = `bub_${Date.now().toString(36)}_${(CALLBACK_SEQ++).toString(36)}`;
    const summary = formatApprovalRequest(req);

    const card = buildPromptCard({
      title: summary.title,
      body: summary.body,
      callbackId,
      kind: req.type,
    });

    let sent: { messageId: string };
    try {
      sent = await this.opts.sendCard(chatId, card);
    } catch (err) {
      return {
        action: "reject",
        feedback: `Failed to send approval card: ${(err as Error).message}`,
      };
    }

    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(callbackId);
        if (!pending) return;
        this.pending.delete(callbackId);
        void this.opts.updateCard(pending.cardMessageId, buildTimeoutCard(summary));
        resolve({ action: "reject", feedback: "Approval timed out after 60s." });
      }, timeoutMs);

      const entry: PendingPrompt = {
        callbackId,
        cardMessageId: sent.messageId,
        originalUserId,
        chatId,
        request: req,
        resolve,
        timer,
      };
      this.pending.set(callbackId, entry);
    });
  }

  /** Called by the channel-level cardAction listener. */
  async dispatch(evt: ApprovalDispatchEvent): Promise<boolean> {
    const value = evt.value as Record<string, unknown> | null | undefined;
    if (!value || typeof value !== "object") return false;
    if (value.__bubble !== "approval") return false;
    const callbackId = String(value.callbackId ?? "");
    const action = String(value.action ?? "");
    const pending = this.pending.get(callbackId);
    if (!pending) {
      // Stale callback or for another instance — silently ignore but consume.
      return true;
    }
    if (evt.cardMessageId !== pending.cardMessageId) return false;

    // Only the original requester may click. Clicks from anyone else are
    // ignored (and we leave the card as-is so the real user can still act).
    if (evt.clickerOpenId !== pending.originalUserId) {
      return true;
    }

    this.pending.delete(callbackId);
    clearTimeout(pending.timer);

    let decision: ApprovalDecision;
    let resultCardKind: "approved" | "rejected" | "remembered" = "approved";
    if (action === "approve") {
      decision = { action: "approve" };
      resultCardKind = "approved";
    } else if (action === "reject") {
      decision = { action: "reject", feedback: "User rejected via Feishu." };
      resultCardKind = "rejected";
    } else if (action === "approve_remember" && pending.request.type === "bash") {
      this.opts.bashAllowlist?.add(pending.request.command);
      decision = { action: "approve" };
      resultCardKind = "remembered";
    } else {
      decision = { action: "reject", feedback: `Unknown approval action: ${action}` };
      resultCardKind = "rejected";
    }

    try {
      await this.opts.updateCard(
        pending.cardMessageId,
        buildResolvedCard(formatApprovalRequest(pending.request), resultCardKind),
      );
    } catch {
      // Best effort — the decision already returned.
    }

    pending.resolve(decision);
    return true;
  }

  /** Reject all pending prompts (e.g. on shutdown or run abort). */
  cancelAll(reason: string = "Run cancelled"): void {
    for (const [callbackId, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(callbackId);
      pending.resolve({ action: "reject", feedback: reason });
    }
  }

  /** Cancel any pending approvals attached to a specific chat (used per scope on /stop). */
  cancelForChat(chatId: string, reason: string = "Run cancelled"): void {
    for (const [callbackId, pending] of this.pending.entries()) {
      if (pending.chatId !== chatId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(callbackId);
      pending.resolve({ action: "reject", feedback: reason });
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

function buildPromptCard(input: {
  title: string;
  body: string;
  callbackId: string;
  kind: ApprovalRequest["type"];
}): object {
  const buttons: object[] = [
    {
      tag: "button",
      text: { tag: "plain_text", content: "✅ 批准" },
      type: "primary",
      value: { __bubble: "approval", callbackId: input.callbackId, action: "approve" },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "❌ 拒绝" },
      type: "danger",
      value: { __bubble: "approval", callbackId: input.callbackId, action: "reject" },
    },
  ];
  if (input.kind === "bash") {
    buttons.push({
      tag: "button",
      text: { tag: "plain_text", content: "✅+ 本会话都允许" },
      type: "default",
      value: { __bubble: "approval", callbackId: input.callbackId, action: "approve_remember" },
    });
  }

  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `⚠️ 需要批准：${input.title}` },
      template: "orange",
    },
    elements: [
      { tag: "markdown", content: input.body },
      { tag: "hr" },
      { tag: "action", actions: buttons },
    ],
  };
}

function buildResolvedCard(summary: { title: string; body: string }, kind: "approved" | "rejected" | "remembered"): object {
  const label = kind === "approved"
    ? "✅ 已批准"
    : kind === "remembered"
    ? "✅ 已批准（本会话内同命令免询问）"
    : "❌ 已拒绝";
  const template = kind === "rejected" ? "red" : "green";
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `${label}：${summary.title}` },
      template,
    },
    elements: [{ tag: "markdown", content: summary.body }],
  };
}

function buildTimeoutCard(summary: { title: string; body: string }): object {
  return {
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `⏱ 超时未响应：${summary.title}` },
      template: "grey",
    },
    elements: [
      { tag: "markdown", content: summary.body },
      { tag: "note", elements: [{ tag: "plain_text", content: "60 秒未点击，已自动拒绝" }] },
    ],
  };
}
