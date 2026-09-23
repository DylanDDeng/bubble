import { describe, expect, it } from "vitest";
import { SessionLog } from "../session-log.js";
import type { Message } from "../types.js";

function visible(messages: Message[]) {
  return messages
    .filter((message) => !(message.role === "meta" && message.includeInLlm === false))
    .map((message) => message.role === "meta"
      ? `meta:${message.content.includes("Plan mode is now ACTIVE") ? "plan" : message.content.includes("bypassPermissions") ? "bypass" : "default"}`
      : message.role);
}

describe("SessionLog mode markers", () => {
  it("states each mode switch before the next user message, never inside a tool group", () => {
    const log = new SessionLog();
    log.appendMarker("mode_switch", "plan");
    log.appendMessage({ role: "user", content: "plan it" });
    log.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t1", name: "exit_plan_mode", arguments: "{}" }],
    } as Message);
    // exit_plan_mode switches mode while its tool call is still open.
    log.appendMarker("mode_switch", "default");
    log.appendMessage({ role: "tool", toolCallId: "t1", content: "approved" } as Message);
    log.appendMarker("mode_switch", "plan");
    log.appendMessage({ role: "user", content: "plan again" });

    const messages = log.toMessages();
    // Switches between two user messages collapse to the last one, and only
    // the latest mode reminder is live; the earlier one stays for the record.
    expect(visible(messages)).toEqual(["user", "assistant", "tool", "meta:plan", "user"]);
    expect(messages.filter((message) => message.role === "meta")).toHaveLength(2);
  });

  it("carries the current mode across a conversation clear", () => {
    const log = new SessionLog();
    log.appendMarker("mode_switch", "bypassPermissions");
    log.appendMessage({ role: "user", content: "before" });
    log.appendMarker("conversation_clear", "");
    log.appendMessage({ role: "user", content: "after" });
    expect(visible(log.toMessages())).toEqual(["meta:bypass", "user"]);
  });

  it("ignores unknown mode values", () => {
    const log = new SessionLog();
    log.appendMarker("mode_switch", "yolo");
    log.appendMessage({ role: "user", content: "hi" });
    expect(visible(log.toMessages())).toEqual(["user"]);
  });
});
