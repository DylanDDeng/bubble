import { describe, expect, it, vi } from "vitest";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";

function ctx(hookController?: any): SlashCommandContext {
  return {
    agent: {} as any,
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    cwd: "/tmp",
    exit: vi.fn(),
    createProvider: vi.fn() as any,
    openPicker: vi.fn(),
    registry: {} as any,
    skillRegistry: {} as any,
    hookController,
  };
}

describe("/hooks slash command", () => {
  it("shows status when hooks are attached", async () => {
    const hookController = {
      status: vi.fn(() => "Hooks status:\n  ok"),
    };
    const result = await slashRegistry.execute("/hooks", ctx(hookController));

    expect(result.handled).toBe(true);
    expect(result.result).toContain("Hooks status");
    expect(hookController.status).toHaveBeenCalledTimes(1);
  });

  it("runs hook test for known events", async () => {
    const hookController = {
      test: vi.fn(async () => "Hook test PreToolUse: allow"),
    };
    const result = await slashRegistry.execute("/hooks test PreToolUse Bash", ctx(hookController));

    expect(result.result).toBe("Hook test PreToolUse: allow");
    expect(hookController.test).toHaveBeenCalledWith("PreToolUse", "Bash");
  });

  it("reports when hooks are unavailable", async () => {
    const result = await slashRegistry.execute("/hooks status", ctx());

    expect(result.result).toContain("not attached");
  });
});
