import test from "node:test";
import assert from "node:assert/strict";
import { DesktopService } from "../electron/service.mjs";
import { snapshotRows, appendEvent } from "../src/timeline.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(turn) {
  let stop;
  const events = [];
  const sdk = {
    listSessions: () => [
      { name: "one", file: "/private/session", cwd: "/tmp", title: "One" },
      { name: "two", file: "/private/two", cwd: "/tmp" },
    ],
    getHistory: () => [{ role: "user", content: "Earlier" }],
    runTurn: turn,
    stop: (id, options) => {
      stop = { id, options };
    },
  };
  return {
    service: new DesktopService(
      sdk,
      (e) => events.push(e),
      async () => [],
    ),
    events,
    stopped: () => stop,
  };
}
test("RPC returns while approval is pending; approval resumes the same turn", async () => {
  const { service, events } = setup(async function* (_id, options) {
    const decision = await options.onApproval({
      type: "bash",
      command: "pwd",
      cwd: "/tmp",
    });
    assert.equal(decision.action, "approve");
    yield { type: "text_delta", content: "Done" };
  });
  assert.equal(
    await service.call("run", { sessionId: "one", prompt: "Hi" }),
    true,
  );
  assert.equal(service.snapshot("one").active, true);
  const request = events.find((e) => e.type === "interaction");
  await service.call("reply", { id: request.id, value: { action: "approve" } });
  await tick();
  assert.equal(service.snapshot("one").active, false);
  assert.ok(
    events.find((e) => e.type === "agent" && e.event.content === "Done"),
  );
  assert.equal(service.sessions()[0].file, undefined);
});
test("stop rejects waiting approvals and cancels queued turns", async () => {
  let decision;
  const { service, stopped } = setup(async function* (_id, options) {
    decision = await options.onApproval({ type: "write", path: "/tmp/x" });
  });
  await service.run("one", { prompt: "Hi" });
  service.stop("one");
  await tick();
  assert.deepEqual(decision, { action: "reject" });
  assert.deepEqual(stopped(), { id: "one", options: { cancelQueued: true } });
  assert.equal(service.pending.size, 0);
});
test("parallel sessions stay separate and duplicate submission cannot create another turn", async () => {
  const { service, events } = setup(async function* (id, options) {
    await options.onQuestion({ questions: [{ question: id }] });
    yield { type: "text_delta", content: id };
  });
  await service.run("one", { prompt: "First" });
  await service.run("two", { prompt: "Second" });
  await assert.rejects(service.run("one", { prompt: "Duplicate" }), /正在运行/);
  assert.equal(service.snapshot("one").interactions.length, 1);
  service.stop("one");
  await tick();
  assert.equal(service.snapshot("two").active, true);
  service.stop("two");
  await tick();
  assert.equal(events.filter((e) => e.type === "finished").length, 2);
});
test("provider failure releases session ownership and emits an actionable error", async () => {
  const { service, events } = setup(async function* () {
    throw new Error("Provider unavailable");
  });
  await service.run("one", { prompt: "Hi" });
  await tick();
  assert.equal(service.snapshot("one").active, false);
  assert.equal(
    events.find((e) => e.type === "failure").message,
    "Provider unavailable",
  );
});
test("invalid modes, empty prompts, unknown sessions and malformed decisions fail closed", async () => {
  const { service } = setup(async function* () {});
  await assert.rejects(
    service.run("one", { prompt: "Hi", mode: "bypassPermissions" }),
  );
  await assert.rejects(service.run("one", { prompt: " " }));
  await assert.rejects(service.run("missing", { prompt: "Hi" }));
  void service.ask("one", "approval", {});
  const id = [...service.pending.keys()][0];
  assert.throws(() => service.reply(id, { action: "allow" }));
  service.settle("one");
  assert.throws(() => service.reply(id, { action: "approve" }));
});
test("history and streamed tools project without exposing system messages", () => {
  const rows = snapshotRows({
    history: [
      { role: "system", content: "Private prompt" },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call", name: "read", arguments: '{"path":"a"}' }],
      },
      { role: "tool", toolCallId: "call", content: "file content" },
    ],
    events: [
      { type: "text_delta", content: "A" },
      { type: "text_delta", content: "B" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].text, "Hello");
  assert.equal(rows[1].output, "file content");
  assert.equal(rows[2].text, "AB");
  const next = appendEvent(rows, {
    type: "tool_start",
    id: "next",
    name: "bash",
    args: { command: "pwd" },
  });
  const ended = appendEvent(next, {
    type: "tool_end",
    id: "next",
    name: "bash",
    result: { content: "failed", isError: true },
  });
  assert.equal(ended.at(-1).status, "error");
  assert.equal(next.at(-1).status, "running");
});
