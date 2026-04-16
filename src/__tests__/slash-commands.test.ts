import { describe, expect, it, vi } from "vitest";
import { registry as slashRegistry } from "../slash-commands/index.js";
import type { SlashCommandContext } from "../slash-commands/types.js";

function createContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    agent: {
      model: "openai:gpt-4o",
      providerId: "openai",
      thinking: "off",
      setSystemPrompt: vi.fn(),
      setProvider: vi.fn(),
    } as any,
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    cwd: "/tmp",
    exit: vi.fn(),
    createProvider: vi.fn() as any,
    openPicker: vi.fn(),
    registry: {
      getEnabled: () => [],
    } as any,
    ...overrides,
  };
}

describe("slash commands", () => {
  it("returns guidance instead of opening an empty model picker when no provider is configured", async () => {
    const ctx = createContext();
    const result = await slashRegistry.execute("/model", ctx);

    expect(result.handled).toBe(true);
    expect(result.result).toBe("No provider configured. Use /login or /provider --add <id> first.");
    expect(ctx.openPicker).not.toHaveBeenCalled();
  });
});
