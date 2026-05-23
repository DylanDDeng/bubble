import { describe, expect, it, vi } from "vitest";
import { FeishuApprovalUI } from "../agent-host/approval-ui.js";
import { BashAllowlist } from "../../approval/session-cache.js";

/** Flush pending Promise microtasks so awaited sends are settled. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeUI(opts: { onSend?: (card: object) => void; onUpdate?: (id: string, card: object) => void } = {}) {
  let nextMessageId = 1;
  const sendCard = vi.fn(async (_chatId: string, card: object) => {
    opts.onSend?.(card);
    return { messageId: `mid_${nextMessageId++}` };
  });
  const updateCard = vi.fn(async (id: string, card: object) => {
    opts.onUpdate?.(id, card);
  });
  const bashAllowlist = new BashAllowlist();
  const ui = new FeishuApprovalUI({ sendCard, updateCard, bashAllowlist, timeoutMs: 200 });
  return { ui, sendCard, updateCard, bashAllowlist };
}

describe("FeishuApprovalUI", () => {
  it("resolves approve on matching click", async () => {
    const { ui, sendCard } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const promise = handler({ type: "bash", command: "ls", cwd: "/tmp" });
    await flushMicrotasks();
    // Pull the callbackId from the card we sent.
    const callValue = sendCard.mock.calls[0]?.[1] as { elements: Array<{ tag: string; actions?: Array<{ value: { callbackId: string; action: string } }> }> };
    const approveBtn = callValue.elements
      .find((e) => e.tag === "action")
      ?.actions?.find((b) => b.value.action === "approve");
    expect(approveBtn).toBeTruthy();
    const callbackId = approveBtn!.value.callbackId;
    const consumed = await ui.dispatch({
      cardMessageId: "mid_1",
      clickerOpenId: "ou_owner",
      value: { __bubble: "approval", callbackId, action: "approve" },
    });
    expect(consumed).toBe(true);
    const decision = await promise;
    expect(decision.action).toBe("approve");
  });

  it("rejects on reject button", async () => {
    const { ui, sendCard } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const promise = handler({ type: "edit", path: "/tmp/x", diff: "@@ -1 +1 @@", fileExists: true });
    await flushMicrotasks();
    const card = sendCard.mock.calls[0]?.[1] as { elements: Array<{ tag: string; actions?: Array<{ value: { callbackId: string; action: string } }> }> };
    const cb = card.elements.find((e) => e.tag === "action")!.actions![0]!.value.callbackId;
    await ui.dispatch({
      cardMessageId: "mid_1",
      clickerOpenId: "ou_owner",
      value: { __bubble: "approval", callbackId: cb, action: "reject" },
    });
    const d = await promise;
    expect(d.action).toBe("reject");
  });

  it("ignores clicks from other users", async () => {
    const { ui, sendCard } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const promise = handler({ type: "bash", command: "ls", cwd: "/tmp" });
    await flushMicrotasks();
    const card = sendCard.mock.calls[0]?.[1] as { elements: Array<{ tag: string; actions?: Array<{ value: { callbackId: string; action: string } }> }> };
    const cb = card.elements.find((e) => e.tag === "action")!.actions![0]!.value.callbackId;
    // Foreign click is ignored.
    await ui.dispatch({
      cardMessageId: "mid_1",
      clickerOpenId: "ou_evil",
      value: { __bubble: "approval", callbackId: cb, action: "approve" },
    });
    // Then real owner clicks.
    await ui.dispatch({
      cardMessageId: "mid_1",
      clickerOpenId: "ou_owner",
      value: { __bubble: "approval", callbackId: cb, action: "approve" },
    });
    const d = await promise;
    expect(d.action).toBe("approve");
  });

  it("times out after timeoutMs", async () => {
    vi.useFakeTimers();
    const { ui } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const promise = handler({ type: "bash", command: "ls", cwd: "/tmp" });
    await vi.advanceTimersByTimeAsync(300);
    const d = await promise;
    expect(d.action).toBe("reject");
    expect(d.feedback).toContain("timed out");
    vi.useRealTimers();
  });

  it("approve_remember adds command to bash allowlist", async () => {
    const { ui, sendCard, bashAllowlist } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const promise = handler({ type: "bash", command: "ls -la", cwd: "/tmp" });
    await flushMicrotasks();
    const card = sendCard.mock.calls[0]?.[1] as { elements: Array<{ tag: string; actions?: Array<{ value: { callbackId: string; action: string } }> }> };
    const cb = card.elements.find((e) => e.tag === "action")!.actions![0]!.value.callbackId;
    await ui.dispatch({
      cardMessageId: "mid_1",
      clickerOpenId: "ou_owner",
      value: { __bubble: "approval", callbackId: cb, action: "approve_remember" },
    });
    const d = await promise;
    expect(d.action).toBe("approve");
    expect(bashAllowlist?.matches("ls -la")).toBe(true);
  });

  it("cancelAll rejects all pending", async () => {
    const { ui } = makeUI();
    const handler = ui.makeHandler("oc_a", "ou_owner");
    const p1 = handler({ type: "bash", command: "a", cwd: "/" });
    const p2 = handler({ type: "bash", command: "b", cwd: "/" });
    ui.cancelAll("test");
    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.action).toBe("reject");
    expect(d2.action).toBe("reject");
  });
});
