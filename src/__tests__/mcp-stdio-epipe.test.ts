import { describe, expect, it } from "vitest";
import { McpManager } from "../mcp/manager.js";
import { StdioTransport } from "../mcp/transports.js";

describe("MCP stdio server that stops reading its input", () => {
  it("reports EPIPE as a transport error instead of crashing the host", async () => {
    // Closes stdin and stays alive; writing after that fails with EPIPE.
    const transport = new StdioTransport({ type: "stdio", command: "sh", args: ["-c", "exec 0<&-; sleep 2"] });
    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));
    await transport.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (let i = 0; i < 20 && errors.length === 0; i++) {
      try {
        await transport.send({ jsonrpc: "2.0", id: i, method: "ping" });
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(errors.some((err) => /stopped reading its input/.test(err.message))).toBe(true);
    await transport.close();
  });

  it("survives a server that exits immediately (e.g. `echo`)", async () => {
    const manager = new McpManager({
      servers: [{ name: "demo", scope: "project", config: { type: "stdio", command: "echo", args: [] } }],
      onDiagnostic: () => {},
    });
    await manager.start();
    expect(manager.getStates()[0].status.kind).not.toBe("connected");
    await manager.shutdown();
  });
});
