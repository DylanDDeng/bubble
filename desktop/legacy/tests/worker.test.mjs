import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test(
  "real SDK worker streams, persists and reloads a turn with isolated local provider",
  { timeout: 30000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bubble-desktop-test-"));
    const bubble = join(home, ".bubble");
    mkdirSync(bubble);
    let providerRequests = 0;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body || "{}");
      providerRequests++;
      const needsTool =
        request.messages?.at(-1)?.content === "Test desktop approval";
      if (needsTool) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ id: "test-tool", object: "chat.completion.chunk", model: "desktop-test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "proof-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf desktop-approval > desktop-proof.txt" }) } }] }, finish_reason: null }] })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({ id: "test-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        {
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Desktop " },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { content: "SDK works." }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        },
      ])
        res.write(
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "desktop-test", ...chunk })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
    writeFileSync(
      join(bubble, "config.json"),
      JSON.stringify({
        defaultProvider: "desktop-test",
        defaultModel: "desktop-test:desktop-test",
      }),
    );
    writeFileSync(
      join(bubble, "models.json"),
      JSON.stringify({
        providers: {
          "desktop-test": {
            baseURL,
            apiKey: "local-test-only",
            models: [{ id: "desktop-test" }],
          },
        },
      }),
    );
    const workerPath =
      process.env.BUBBLE_TEST_WORKER ||
      fileURLToPath(new URL("../electron/worker.mjs", import.meta.url));
    const child = fork(workerPath, [], {
      execPath: process.env.BUBBLE_TEST_NODE || process.execPath,
      cwd: home,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        HOME: home,
        BUBBLE_HOME: bubble,
        BUBBLE_SDK_ROOT: process.env.BUBBLE_TEST_RUNTIME || resolve(".."),
        BUBBLE_DESKTOP_CWD: home,
      },
    });
    child.stdout.resume();
    child.stderr.resume();
    let next = 0;
    const pending = new Map();
    const events = [];
    const ready = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("message", (message) => {
        if (message.ready) resolve();
        if (message.event) events.push(message.event);
        const p = pending.get(message.id);
        if (p) {
          pending.delete(message.id);
          message.error
            ? p.reject(new Error(message.error))
            : p.resolve(message.result);
        }
      });
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        child.send({ id, method, params });
      });
    try {
      await ready;
      const data = await call("bootstrap");
      assert.equal(data.models[0].id, "desktop-test:desktop-test");
      assert.equal(JSON.stringify(data).includes("local-test-only"), false);
      const { id } = await call("create", { cwd: home });
      await call("run", {
        sessionId: id,
        prompt: "Say hello",
        model: "desktop-test:desktop-test",
      });
      const deadline = Date.now() + 15000;
      while (
        !events.find((e) => e.type === "finished") &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        events.find((e) => e.type === "failure"),
        undefined,
      );
      assert.ok(events.some((e) => e.type === "finished"));
      assert.ok(providerRequests > 0);
      const snapshot = await call("snapshot", { sessionId: id });
      assert.equal(snapshot.active, false);
      assert.ok(
        snapshot.history.some(
          (m) => m.role === "assistant" && m.content === "Desktop SDK works.",
        ),
      );
      assert.ok((await call("sessions")).some((s) => s.name === id));
      await assert.rejects(call("notAllowed"), /Unknown desktop method/);
      events.length = 0;
      await call("run", {
        sessionId: id,
        prompt: "Test desktop approval",
        model: "desktop-test:desktop-test",
      });
      const approvalDeadline = Date.now() + 10000;
      while (
        !events.some((e) => e.type === "interaction") &&
        Date.now() < approvalDeadline
      )
        await new Promise((r) => setTimeout(r, 20));
      const approval = events.find((e) => e.type === "interaction");
      assert.ok(approval, JSON.stringify(events));
      assert.equal(approval.kind, "approval");
      assert.equal(existsSync(join(home, "desktop-proof.txt")), false);
      await call("reply", { id: approval.id, value: { action: "approve" } });
      const finishDeadline = Date.now() + 10000;
      while (
        !events.some((e) => e.type === "finished") &&
        Date.now() < finishDeadline
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(
        readFileSync(join(home, "desktop-proof.txt"), "utf8"),
        "desktop-approval",
      );
      assert.ok(
        events.some((e) => e.type === "agent" && e.event.type === "tool_end"),
      );
      assert.ok(events.some((e) => e.type === "finished"));
    } finally {
      child.kill();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await new Promise((r) =>
        child.exitCode !== null ? r() : child.once("exit", r),
      );
      rmSync(home, { recursive: true, force: true });
    }
  },
);
