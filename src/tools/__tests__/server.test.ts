import net from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedServerTools } from "../server.js";
import { startManagedServer, stopAutoServersForSession, stopManagedServer } from "../server-manager.js";

describe("managed server tools", () => {
  const cwd = join(tmpdir(), "bubble-managed-server-" + process.pid);
  const startedIds: string[] = [];
  mkdirSync(cwd, { recursive: true });

  afterEach(async () => {
    await Promise.all(startedIds.splice(0).map((id) => stopManagedServer(id)));
  });

  it("starts, reports, logs, and stops a managed server", async () => {
    const port = await getFreePort();
    const command = nodeHttpServerCommand(port);
    const tools = createManagedServerTools(cwd);
    const start = tools.find((tool) => tool.name === "start_server")!;
    const status = tools.find((tool) => tool.name === "server_status")!;
    const logs = tools.find((tool) => tool.name === "server_logs")!;
    const stop = tools.find((tool) => tool.name === "stop_server")!;

    const started = await start.execute({
      command,
      port,
      readinessUrl: `http://127.0.0.1:${port}/health`,
      timeout: 5,
      lifecycle: "keep_alive",
    }, {
      cwd,
      sessionID: "test-session",
      toolCall: { id: "tool-start", name: "start_server" },
    });

    expect(started.isError).toBeUndefined();
    expect(started.status).toBe("success");
    const serverId = String(started.metadata?.serverId);
    startedIds.push(serverId);
    expect(started.content).toContain(serverId);
    await expect(fetch(`http://127.0.0.1:${port}/health`).then((res) => res.text())).resolves.toBe("ok");

    const serverStatus = await status.execute({ serverId }, { cwd });
    expect(serverStatus.isError).toBeUndefined();
    expect(serverStatus.content).toContain("ready");
    expect(serverStatus.content).toContain(String(port));

    const serverLogs = await logs.execute({ serverId }, { cwd });
    expect(serverLogs.isError).toBeUndefined();
    expect(serverLogs.content).toContain("ready");

    const stopped = await stop.execute({ serverId }, { cwd });
    expect(stopped.isError).toBeUndefined();
    expect(stopped.content).toContain("Stopped");
    startedIds.splice(startedIds.indexOf(serverId), 1);
    await waitFor(async () => !(await isPortOpen(port)));
  });

  it("stops auto lifecycle servers for a session", async () => {
    const port = await getFreePort();
    const server = await startManagedServer({
      command: nodeHttpServerCommand(port),
      cwd,
      port,
      readinessUrl: `http://127.0.0.1:${port}/health`,
      timeoutSec: 5,
      ownerSessionId: "auto-session",
      lifecycle: "auto",
      purpose: "verification",
    });
    startedIds.push(server.id);

    await expect(fetch(`http://127.0.0.1:${port}/health`).then((res) => res.text())).resolves.toBe("ok");
    await stopAutoServersForSession("auto-session");
    startedIds.splice(startedIds.indexOf(server.id), 1);
    await waitFor(async () => !(await isPortOpen(port)));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
  });
});

function nodeHttpServerCommand(port: number): string {
  const script = [
    "const http=require('http')",
    "const port=Number(process.argv[1])",
    "const server=http.createServer((req,res)=>{res.end(req.url==='/health'?'ok':'hello')})",
    "server.listen(port,'127.0.0.1',()=>console.log('ready '+port))",
    "process.on('SIGTERM',()=>server.close(()=>process.exit(0)))",
  ].join(";");
  return `node -e ${JSON.stringify(script)} ${port}`;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("No port assigned"));
      });
    });
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(100, () => done(false));
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await predicate()).toBe(true);
}
