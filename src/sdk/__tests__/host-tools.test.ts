import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BubbleSdk,
  type Provider,
  type ToolRegistryEntry,
  type Message,
} from "../index.js";
import { toolImageObservation } from "../../context/tool-images.js";

const cwd = mkdtempSync(join(tmpdir(), "bubble-host-tools-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5XcAAAAASUVORK5CYII=";
function sdkWith(provider: Provider) {
  const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
  (sdk as any).resolveProvider = () => ({
    provider,
    providerId: "test",
    model: "test:model",
  });
  return sdk;
}
const drain = async (events: AsyncIterable<unknown>) => {
  for await (const _ of events) {
  }
};

describe("turn-scoped host tools", () => {
  it("calls the host tool, then sends a real image observation after the entire tool batch", async () => {
    let calls = 0;
    let continuation: Message[] = [];
    const provider: Provider = {
      async *streamChat(messages, options) {
        calls++;
        if (calls === 1) {
          expect(options.tools?.some((t) => t.name === "design_test")).toBe(
            true,
          );
          yield {
            type: "tool_call",
            id: "preview",
            name: "design_test",
            arguments: "{}",
            isStart: true,
            isEnd: true,
          };
        } else {
          continuation = structuredClone(messages);
          yield { type: "text", content: "Viewed design" };
        }
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    };
    const sdk = sdkWith(provider);
    const session = sdk.createSession();
    const tool: ToolRegistryEntry = {
      name: "design_test",
      description: "preview",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      execute: async () => ({
        content: '{"revision":3}',
        images: [{ mimeType: "image/png", data: png }],
      }),
    };
    await drain(
      sdk.runTurn(session.id, { prompt: "preview", hostTools: [tool] }),
    );
    const index = continuation.findIndex(
      (m) => m.role === "tool" && m.toolCallId === "preview",
    );
    expect(index).toBeGreaterThan(-1);
    const observation = continuation
      .slice(index + 1)
      .find((m) => m.role === "user" && Array.isArray(m.content));
    expect(observation).toMatchObject({
      role: "user",
      toolObservation: true,
      content: [
        { type: "text" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${png}` },
        },
      ],
    });
    expect(
      sdk
        .getHistory(session.id)
        .some((m) => m.role === "user" && Array.isArray(m.content)),
    ).toBe(true);
    await sdk.deleteSession(session.id);
  });
  it("does not leak one turn’s host catalog into the next session", async () => {
    const catalogs: string[][] = [];
    const sdk = sdkWith({
      async *streamChat(_m, o) {
        catalogs.push(o.tools?.map((t) => t.name) ?? []);
        yield { type: "text", content: "Done" };
        yield { type: "done" };
      },
      async complete() {
        return "";
      },
    });
    const a = sdk.createSession(),
      b = sdk.createSession();
    const tool: ToolRegistryEntry = {
      name: "design_private",
      description: "scoped",
      parameters: { type: "object", properties: {} },
      readOnly: true,
      execute: async () => ({ content: "ok" }),
    };
    await drain(sdk.runTurn(a.id, { prompt: "A", hostTools: [tool] }));
    await drain(sdk.runTurn(b.id, { prompt: "B" }));
    expect(catalogs[0]).toContain("design_private");
    expect(catalogs[1]).not.toContain("design_private");
    await sdk.deleteSession(a.id);
    await sdk.deleteSession(b.id);
  });
  it("rejects malformed, oversized and failed tool images", () => {
    expect(
      toolImageObservation([
        {
          content: "x",
          isError: true,
          images: [{ mimeType: "image/png", data: png }],
        },
      ]),
    ).toBeNull();
    expect(
      toolImageObservation([
        {
          content: "x",
          images: [{ mimeType: "image/png", data: "a".repeat(4_000_001) }],
        },
      ]),
    ).toBeNull();
    expect(
      toolImageObservation([
        {
          content: "x",
          images: [
            {
              mimeType: "image/png",
              data: Buffer.from("<script>x</script>").toString("base64"),
            },
          ],
        },
      ]),
    ).toBeNull();
  });
});
