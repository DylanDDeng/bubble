import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences } from "@bubblebrain-ai/pi-tui";
import { FeishuSetupDialogComponent, type FeishuSetupResult } from "../tui/components/feishu-setup-dialog.js";

function rendered(component: FeishuSetupDialogComponent): string {
  return stripTerminalSequences(component.render(100).join("\n"));
}

describe("Feishu setup dialog", () => {
  it("registers, saves credentials, and binds the first chat", async () => {
    let resolveRegistration!: (result: {
      client_id: string;
      client_secret: string;
      user_info: { open_id: string };
    }) => void;
    const register = vi.fn(async (options: {
      onQRCodeReady(info: { url: string; expireIn: number }): void;
    }) => {
      options.onQRCodeReady({ url: "https://open.feishu.cn/qr/test", expireIn: 60 });
      return new Promise<{
        client_id: string;
        client_secret: string;
        user_info: { open_id: string };
      }>((resolve) => { resolveRegistration = resolve; });
    });
    const saveCredentials = vi.fn();
    const saveScope = vi.fn();
    const results: FeishuSetupResult[] = [];
    const component = new FeishuSetupDialogComponent({
      getTerminalRows: () => 30,
      register,
      renderQr: async () => "QR-LINE-1\nQR-LINE-2",
      saveCredentials,
      saveScope,
      onResult: (result) => results.push(result),
      onRender: () => {},
    });

    component.start();
    await vi.waitFor(() => expect(rendered(component)).toContain("QR-LINE-1"));
    resolveRegistration({
      client_id: "cli_app",
      client_secret: "secret",
      user_info: { open_id: "ou_owner" },
    });
    await vi.waitFor(() => expect(rendered(component)).toContain("注册成功"));
    expect(saveCredentials).toHaveBeenCalledWith({
      appId: "cli_app",
      appSecret: "secret",
      ownerOpenId: "ou_owner",
    });

    component.handleInput("\r");
    component.handleInput("oc_chat");
    component.handleInput("\r");
    component.handleInput(process.cwd());
    component.handleInput("\r");
    component.handleInput("\r");

    expect(saveScope).toHaveBeenCalledWith("oc_chat", expect.objectContaining({
      cwd: process.cwd(),
      displayName: expect.any(String),
      allowedUsers: ["ou_owner"],
      admins: ["ou_owner"],
    }));
    expect(results).toEqual([expect.objectContaining({ kind: "completed" })]);
  });

  it("aborts an in-flight registration when cancelled", () => {
    let signal: AbortSignal | undefined;
    const onResult = vi.fn();
    const component = new FeishuSetupDialogComponent({
      getTerminalRows: () => 24,
      register: (options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      onResult,
      onRender: () => {},
    });

    component.start();
    component.handleInput("\x1b");

    expect(signal?.aborted).toBe(true);
    expect(onResult).toHaveBeenCalledWith({ kind: "cancelled" });
  });

  it("surfaces registration failures before dismissing the workflow", async () => {
    const onResult = vi.fn();
    const component = new FeishuSetupDialogComponent({
      getTerminalRows: () => 24,
      register: async () => { throw new Error("registration unavailable"); },
      onResult,
      onRender: () => {},
    });

    component.start();
    await vi.waitFor(() => expect(rendered(component)).toContain("registration unavailable"));
    expect(onResult).not.toHaveBeenCalled();

    component.handleInput("\r");
    expect(onResult).toHaveBeenCalledWith({ kind: "error", message: "registration unavailable" });
  });
});
