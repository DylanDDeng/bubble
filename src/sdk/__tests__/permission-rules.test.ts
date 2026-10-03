import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BubbleSdk, type AgentEvent, type Provider } from "../index.js";

let root: string;
const originalBubbleHome = process.env.BUBBLE_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bubble-sdk-rules-"));
  process.env.BUBBLE_HOME = join(root, "home");
});
afterEach(() => {
  if (originalBubbleHome === undefined) delete process.env.BUBBLE_HOME;
  else process.env.BUBBLE_HOME = originalBubbleHome;
  rmSync(root, { recursive: true, force: true });
});

function bashOnce(command: string): { provider: Provider; toolResult: () => string } {
  let call = 0;
  let result = "";
  const provider: Provider = {
    async *streamChat(messages) {
      call += 1;
      if (call === 1) {
        yield { type: "tool_call", id: "bash_1", name: "bash", arguments: JSON.stringify({ command }), isStart: true, isEnd: true };
        yield { type: "done" };
        return;
      }
      const tool = messages.find((message) => message.role === "tool");
      result = typeof tool?.content === "string" ? tool.content : "";
      yield { type: "text", content: "done" };
      yield { type: "done" };
    },
    async complete() { return ""; },
  };
  return { provider, toolResult: () => result };
}

async function runTurn(cwd: string, provider: Provider, mode: "default" | "bypassPermissions", onApproval?: () => Promise<{ action: "approve" | "reject" }>) {
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  (sdk as unknown as { resolveProvider: () => unknown }).resolveProvider = () => ({ provider, providerId: "test", model: "test:model" });
  const session = sdk.createSession({ id: `rules-${Date.now()}-${Math.random()}`, cwd });
  const events: AgentEvent[] = [];
  for await (const event of sdk.runTurn(session.id, { prompt: "go", mode, onApproval })) events.push(event);
  return events;
}

describe("BubbleSdk permission rules", () => {
  it("applies project deny rules even under bypassPermissions", async () => {
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(join(cwd, ".bubble", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(echo:*)"] } }));
    const { provider, toolResult } = bashOnce("echo hacked");
    await runTurn(cwd, provider, "bypassPermissions");
    expect(toolResult()).toContain("Blocked by deny rule");
  });

  it("asks the host once per folder before loading repository settings", async () => {
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(join(cwd, ".bubble", "settings.json"), JSON.stringify({
      permissions: { allow: ["Bash"] },
      mcpServers: { tracker: { type: "stdio", command: "tracker-mcp" } },
      lsp: { custom: { command: ["custom-lsp"], extensions: [".x"] } },
    }));
    const asked: unknown[] = [];
    const approvals: string[] = [];
    const run = async (answer: boolean) => {
      const { provider, toolResult } = bashOnce("echo hi");
      const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
      (sdk as unknown as { resolveProvider: () => unknown }).resolveProvider = () => ({ provider, providerId: "test", model: "test:model" });
      const session = sdk.createSession({ id: `trust-${Date.now()}-${Math.random()}`, cwd });
      for (let turn = 0; turn < 2; turn++) {
        for await (const _ of sdk.runTurn(session.id, {
          prompt: "go",
          mode: "default",
          onProjectTrust: async (request) => { asked.push(request); return answer; },
          onApproval: async () => { approvals.push("bash"); return { action: "reject" }; },
        })) { /* drain */ }
      }
      return toolResult();
    };

    // Declined: asked once per SDK instance, and the repo's allow rule stays off.
    await run(false);
    expect(asked).toEqual([{ cwd, pending: { allow: ["Bash"], mcpServers: ["tracker"], lspServers: ["custom"] } }]);
    expect(approvals.length).toBeGreaterThan(0);

    // Trusted: the repo's `Bash` allow rule applies without a prompt.
    asked.length = 0;
    approvals.length = 0;
    await run(true);
    expect(asked).toHaveLength(1);
    expect(approvals).toEqual([]);
  });

  it("ignores untrusted repository allow rules", async () => {
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".bubble"), { recursive: true });
    writeFileSync(join(cwd, ".bubble", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
    const asked: string[] = [];
    const { provider, toolResult } = bashOnce("echo hi");
    await runTurn(cwd, provider, "default", async () => {
      asked.push("bash");
      return { action: "reject" };
    });
    expect(asked).toEqual(["bash"]);
    expect(toolResult()).toContain("rejected");
  });
});
