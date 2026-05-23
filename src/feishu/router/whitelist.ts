/**
 * Three gates: scope (chat known?), user (in allowedUsers?), mention (group + requireMention?).
 *
 * Failed gates return reasons that the caller may log but should NOT reflect
 * back to the user (silent drop) — surfacing the bot's existence is its own
 * security exposure.
 */

import type { ScopeConfig } from "../types.js";

export type WhitelistResult =
  | { ok: true }
  | { ok: false; reason: "scope_not_found" | "user_not_allowed" | "no_mention_in_group" | "topic_chat_unsupported" };

export interface WhitelistCheckInput {
  chatId: string;
  userId: string;
  chatType: "p2p" | "group" | "topic";
  mentionedBot: boolean;
  scope: ScopeConfig | undefined;
  requireMentionInGroup: boolean;
}

export function checkWhitelist(input: WhitelistCheckInput): WhitelistResult {
  if (!input.scope) return { ok: false, reason: "scope_not_found" };
  if (input.chatType === "topic") return { ok: false, reason: "topic_chat_unsupported" };
  if (!input.scope.allowedUsers.includes(input.userId)) {
    return { ok: false, reason: "user_not_allowed" };
  }
  if (input.chatType === "group" && input.requireMentionInGroup && !input.mentionedBot) {
    return { ok: false, reason: "no_mention_in_group" };
  }
  return { ok: true };
}
