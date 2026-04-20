import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpManager } from "../mcp/manager.js";
import type { ScopedMcpServerConfig } from "../mcp/types.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/mcp-fake-server.mjs",
);

describe("McpManager", () => {
  it("connects to a stdio server, exposes its tools, calls them", async () => {
    const servers: ScopedMcpServerConfig[] = [
      {
        name: "fakesvr",
        scope: "user",
        config: { type: "stdio", command: process.execPath, args: [FIXTURE] },
      },
    ];

    const diagnostics: string[] = [];
    const manager = new McpManager({
      servers,
      onDiagnostic: (m) => diagnostics.push(m),
    });
    try {
      await manager.start();

      const states = manager.getStates();
      expect(states).toHaveLength(1);
      const state = states[0];
      expect(state.status.kind).toBe("connected");
      if (state.status.kind === "connected") {
        expect(state.status.tools).toHaveLength(1);
        expect(state.status.tools[0].name).toBe("echo");
        expect(state.status.prompts).toHaveLength(1);
        expect(state.status.prompts[0].name).toBe("greet");
      }

      const entries = manager.getToolEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("mcp__fakesvr__echo");
      expect(entries[0].deferred).toBe(true);
      expect(entries[0].parameters.properties).toHaveProperty("text");

      const result = await entries[0].execute({ text: "hello" }, { cwd: process.cwd() });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain("echo:hello");

      // Prompt exposed as a synthetic slash command with inject output.
      const commands = manager.getPromptCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe("mcp__fakesvr__greet");

      const out = await commands[0].handler('"Ada Lovelace" formal', {} as any);
      expect(out).toEqual({ inject: "Hello Ada Lovelace! (formal)" });

      // Required arg missing → error string, not inject.
      const missing = await commands[0].handler("", {} as any);
      expect(typeof missing).toBe("string");
      expect(missing).toMatch(/missing required/i);
    } finally {
      await manager.shutdown();
    }
  });

  it("captures per-server failure without throwing", async () => {
    const servers: ScopedMcpServerConfig[] = [
      {
        name: "broken",
        scope: "user",
        config: { type: "stdio", command: "/definitely/not/a/real/binary/path/xyz" },
      },
    ];

    const diagnostics: string[] = [];
    const manager = new McpManager({
      servers,
      onDiagnostic: (m) => diagnostics.push(m),
    });
    await manager.start();

    const states = manager.getStates();
    expect(states[0].status.kind).toBe("failed");
    expect(diagnostics[0]).toMatch(/broken/);
    expect(manager.getToolEntries()).toHaveLength(0);

    await manager.shutdown();
  });
});
