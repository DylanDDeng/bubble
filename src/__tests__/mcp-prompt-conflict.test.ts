import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpManager } from "../mcp/manager.js";
import type { ScopedMcpServerConfig } from "../mcp/types.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/mcp-fake-server.mjs",
);

describe("MCP prompt name conflicts", () => {
  it("last-connected server wins and emits a shadow diagnostic", async () => {
    // Two servers, both exposing the same prompt "greet" (same fixture binary,
    // different server names). Flat /<name> namespace means one must shadow
    // the other — we keep the last-registered and warn so the user knows.
    const servers: ScopedMcpServerConfig[] = [
      {
        name: "alpha",
        scope: "user",
        config: { type: "stdio", command: process.execPath, args: [FIXTURE] },
      },
      {
        name: "beta",
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

      const commands = manager.getPromptCommands();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe("greet");
      // Insertion order in the map follows server declaration order in the
      // config, so "beta" wins over "alpha".
      expect(commands[0].sourceLabel).toBe("beta");

      const shadowLog = diagnostics.find((m) => m.includes("shadows"));
      expect(shadowLog).toBeDefined();
      expect(shadowLog).toMatch(/\/greet/);
      expect(shadowLog).toMatch(/beta/);
      expect(shadowLog).toMatch(/alpha/);
    } finally {
      await manager.shutdown();
    }
  });
});
