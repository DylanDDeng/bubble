import { describe, expect, it } from "vitest";
import { checkWhitelist } from "../router/whitelist.js";
import type { ScopeConfig } from "../types.js";

function makeScope(overrides: Partial<ScopeConfig> = {}): ScopeConfig {
  return {
    cwd: "/tmp/proj",
    displayName: "proj",
    allowedUsers: ["ou_alice"],
    admins: ["ou_alice"],
    defaultPermissionMode: "default",
    model: null,
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

describe("whitelist gates", () => {
  it("rejects unknown chat", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "p2p",
      mentionedBot: false,
      scope: undefined,
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scope_not_found");
  });

  it("rejects topic chats", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "topic",
      mentionedBot: false,
      scope: makeScope(),
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("topic_chat_unsupported");
  });

  it("rejects users not in allowedUsers", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_bob",
      chatType: "p2p",
      mentionedBot: false,
      scope: makeScope(),
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("user_not_allowed");
  });

  it("requires mention in groups by default", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "group",
      mentionedBot: false,
      scope: makeScope(),
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_mention_in_group");
  });

  it("passes when mention present in group", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "group",
      mentionedBot: true,
      scope: makeScope(),
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(true);
  });

  it("does not require mention in p2p", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "p2p",
      mentionedBot: false,
      scope: makeScope(),
      requireMentionInGroup: true,
    });
    expect(r.ok).toBe(true);
  });

  it("ignores requireMention setting in p2p", () => {
    const r = checkWhitelist({
      chatId: "oc_x",
      userId: "ou_alice",
      chatType: "p2p",
      mentionedBot: false,
      scope: makeScope(),
      requireMentionInGroup: false,
    });
    expect(r.ok).toBe(true);
  });
});
