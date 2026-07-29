import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import type { AgentEvent, Provider, StreamChunk, ToolRegistryEntry } from "../types.js";

// Modified-existing-tests disclosure (docs/harness-thinning.md): the one
// piece kept from the removed completion gate. A run that touched test files
// which already existed at run start gets ONE informational reminder built
// from git ground truth; runs that change no existing tests end without any
// forced continuation.

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "bubble-disclosure-"));
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "T"]);
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "app.test.ts"), "test line one\ntest line two\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "init"]);
  return repo;
}

function providerFromTurns(turns: StreamChunk[][]): Provider {
  let index = 0;
  return {
    async *streamChat() {
      const chunks = turns[index++] ?? [{ type: "text", content: "fallback final answer" }];
      for (const chunk of chunks) yield chunk;
      yield { type: "done" };
    },
    async complete() {
      return "complete";
    },
  };
}

/** A write tool that actually mutates files on disk so git sees it. */
function realWriteTool(repo: string): ToolRegistryEntry {
  return {
    name: "write",
    description: "write a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    async execute(args: { path?: string; content?: string }) {
      const target = join(repo, String(args.path ?? "out.txt"));
      writeFileSync(target, String(args.content ?? ""));
      return { content: "ok", isError: false, metadata: { kind: "write", path: target } };
    },
  } as unknown as ToolRegistryEntry;
}

function writeCall(seq: number, path: string, content: string): StreamChunk[] {
  const args = JSON.stringify({ path, content });
  return [
    { type: "tool_call", id: `w${seq}`, name: "write", arguments: "", isStart: true, isEnd: false },
    { type: "tool_call", id: `w${seq}`, name: "write", arguments: "", argumentsFull: args, isStart: false, isEnd: true },
  ];
}

function textTurn(content: string): StreamChunk[] {
  return [{ type: "text", content }];
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function metaReminders(agent: Agent): string[] {
  return agent.messages
    .filter((message): message is Extract<typeof agent.messages[number], { role: "meta" }> => message.role === "meta")
    .map((message) => message.content);
}

describe("modified-existing-tests disclosure", () => {
  it("fires once, listing the touched pre-existing test file", async () => {
    const repo = makeRepo();
    const agent = new Agent({
      provider: providerFromTurns([
        writeCall(1, "app.test.ts", "totally rewritten\n"),  // touches an EXISTING test
        textTurn("all done"),                                  // tries to finish -> disclosure
        textTurn("declared and final"),                        // finishes for real
      ]),
      model: "test-model",
      tools: [realWriteTool(repo)],
    });

    await collect(agent.run("update the test", repo));

    const disclosures = metaReminders(agent).filter((content) => content.includes("modified pre-existing test files"));
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("app.test.ts");
  });

  it("does not fire when the run only changes non-test files", async () => {
    const repo = makeRepo();
    const agent = new Agent({
      provider: providerFromTurns([
        writeCall(1, "app.ts", "export const x = 2;\n"),
        textTurn("all done"),
      ]),
      model: "test-model",
      tools: [realWriteTool(repo)],
    });

    await collect(agent.run("change the app", repo));

    const disclosures = metaReminders(agent).filter((content) => content.includes("modified pre-existing test files"));
    expect(disclosures).toHaveLength(0);
  });

  it("does not fire for brand-new test files", async () => {
    const repo = makeRepo();
    const agent = new Agent({
      provider: providerFromTurns([
        writeCall(1, "fresh.test.ts", "brand new test\n"),
        textTurn("all done"),
      ]),
      model: "test-model",
      tools: [realWriteTool(repo)],
    });

    await collect(agent.run("add a test", repo));

    // New tests are the model's own work product, not a silent modification
    // of prior expectations — no disclosure.
    const disclosures = metaReminders(agent).filter((content) => content.includes("modified pre-existing test files"));
    expect(disclosures).toHaveLength(0);
  });
});
