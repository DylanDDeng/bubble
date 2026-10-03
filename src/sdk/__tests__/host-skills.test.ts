import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BubbleSdk, type Message, type Provider } from "../index.js";

const root = mkdtempSync(join(tmpdir(), "bubble-host-skills-"));
const cwd = join(root, "project");
const bundled = join(root, "bundled");
mkdirSync(cwd);
mkdirSync(join(bundled, "host-guide"), { recursive: true });
writeFileSync(
  join(bundled, "host-guide", "SKILL.md"),
  "---\nname: host-guide\ndescription: Shipped by the host app.\n---\n\nUse the house style.\n",
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sdkWith(provider: Provider) {
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  (sdk as any).resolveProvider = () => ({ provider, providerId: "test", model: "test:model" });
  return sdk;
}

describe("host skill paths", () => {
  it("lists host skills and loads them only in turns that pass them", async () => {
    let calls = 0;
    const seen: Message[][] = [];
    const provider: Provider = {
      async *streamChat(messages) {
        calls++;
        if (calls % 2 === 1) {
          yield { type: "tool_call", id: `load-${calls}`, name: "skill", arguments: '{"name":"host-guide"}', isStart: true, isEnd: true };
        } else {
          seen.push(structuredClone(messages));
          yield { type: "text", content: "ok" };
        }
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    };
    const sdk = sdkWith(provider);
    expect(sdk.listSkills(cwd).some((s) => s.name === "host-guide")).toBe(false);
    expect(sdk.listSkills(cwd, [bundled]).some((s) => s.name === "host-guide")).toBe(true);
    const session = sdk.createSession({ cwd });
    for await (const _ of sdk.runTurn(session.id, { prompt: "style?", skillPaths: [bundled], mode: "bypassPermissions" })) {
    }
    const lastToolResult = (messages: Message[]) => JSON.stringify(messages.at(-1));
    expect(lastToolResult(seen[0])).toContain("Use the house style.");
    for await (const _ of sdk.runTurn(session.id, { prompt: "again?", mode: "bypassPermissions" })) {
    }
    expect(seen).toHaveLength(2);
    expect(lastToolResult(seen[1])).not.toContain("Use the house style.");
  });
});
