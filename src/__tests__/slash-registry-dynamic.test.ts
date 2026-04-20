import { describe, expect, it } from "vitest";
import { SlashCommandRegistry } from "../slash-commands/registry.js";
import type { SlashCommandContext } from "../slash-commands/types.js";

const fakeCtx = {
  skillRegistry: { get: () => undefined },
} as unknown as SlashCommandContext;

describe("SlashCommandRegistry", () => {
  it("exposes dynamic commands via list / get / execute", async () => {
    const reg = new SlashCommandRegistry();
    reg.addDynamicSource(() => [
      {
        name: "dyn",
        description: "test",
        async handler(args: string) {
          return `got:${args}`;
        },
      },
    ]);

    expect(reg.list().map((c) => c.name)).toEqual(["dyn"]);
    expect(reg.get("dyn")?.name).toBe("dyn");
    const { handled, result } = await reg.execute("/dyn hello", fakeCtx);
    expect(handled).toBe(true);
    expect(result).toBe("got:hello");
  });

  it("passes through inject payloads from handlers", async () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: "inject",
      description: "test",
      async handler() {
        return { inject: "please do X" };
      },
    });
    const { handled, inject, result } = await reg.execute("/inject", fakeCtx);
    expect(handled).toBe(true);
    expect(inject).toBe("please do X");
    expect(result).toBeUndefined();
  });

  it("builtin commands still take precedence over dynamic ones on name clash", async () => {
    const reg = new SlashCommandRegistry();
    reg.register({
      name: "same",
      description: "builtin",
      async handler() {
        return "from-builtin";
      },
    });
    reg.addDynamicSource(() => [
      {
        name: "same",
        description: "dynamic",
        async handler() {
          return "from-dynamic";
        },
      },
    ]);
    const { result } = await reg.execute("/same", fakeCtx);
    expect(result).toBe("from-builtin");
  });
});
