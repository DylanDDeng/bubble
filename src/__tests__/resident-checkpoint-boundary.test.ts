import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../agent.js";
import { SessionManager } from "../session.js";
import { createContextCheckpoint, type ContextCheckpoint } from "../context/checkpoint.js";
import { getContextBudget } from "../context/budget.js";
import { buildCompactionSummaryMessage, isCompactionSummaryMessage } from "../context/compact.js";
import { projectMessages } from "../context/projector.js";
import { registerDynamicModelMetadata } from "../model-catalog.js";
import { formatInternalContextBlock, formatInternalReminderBlock } from "../agent/internal-reminder-sanitizer.js";
import type { Message, Provider, ToolRegistryEntry } from "../types.js";

const providerId = "resident-regression";
const modelId = "boundary-16000";
const dirs: string[] = [];
beforeEach(() => {
  const usage = process.memoryUsage();
  vi.spyOn(process, "memoryUsage").mockReturnValue({ ...usage, heapUsed: 768 * 1024 * 1024 });
  registerDynamicModelMetadata({ id: modelId, name: modelId, providerId, reasoningLevels: ["off"], contextWindow: 16_000 });
});
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
function history(chars: number): Message[] {
  return Array.from({ length: 8 }, (_, i): Message[] => [
    { role: "user", content: `Task ${i}: preserve my requirements` },
    { role: "assistant", content: `Completed ${i}: ` + "detail ".repeat(Math.ceil(chars / 7)) },
  ]).flat();
}
function fixture(messages: Message[], provider: Provider = {} as Provider, tools: ToolRegistryEntry[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "bubble-resident-boundary-"));
  dirs.push(dir);
  const file = join(dir, "session.jsonl");
  const manager = new SessionManager(file);
  messages.forEach(message => manager.appendMessage(message));
  const checkpoints: ContextCheckpoint[] = [];
  const agent = new Agent({
    provider, providerId, model: `${providerId}:${modelId}`, tools,
    onMessageAppend: message => manager.appendMessage(message),
    getContextRevision: () => manager.getRevision(),
    onContextCheckpoint: checkpoint => {
      manager.commitContextCheckpoint(checkpoint);
      checkpoints.push(checkpoint);
    },
  });
  agent.messages = messages;
  return { agent, file, manager, checkpoints };
}
const budget = (messages: Message[]) => getContextBudget(providerId, modelId, messages);

describe("real resident checkpoint boundaries", () => {
  it("keeps exactly one live recent mode reminder and none durable, including after retirement/reopen", () => {
    const { agent, file, checkpoints } = fixture(history(8000));
    agent.setMode("plan");
    const reminder = agent.messages.at(-1)!;
    const marker = "Plan mode is now ACTIVE";
    expect(String(reminder.content)).toContain(marker);
    const before = JSON.stringify(agent.messages).length;
    expect(budget(agent.messages).shouldCompact).toBe(true);

    agent.compactResidentHistory();

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].reason).toBe("resident");
    expect(JSON.stringify(agent.messages).length).toBeLessThan(before);
    expect(agent.messages.filter(m => String(m.content).includes(marker))).toEqual([reminder]);
    expect(agent.messages.at(-1)).toBe(reminder);
    expect(projectMessages(agent.messages).filter(m => String(m.content).includes(marker))).toHaveLength(1);
    expect(JSON.stringify(checkpoints[0])).not.toContain(marker);
    expect(JSON.stringify(new SessionManager(file).getMessages())).not.toContain(marker);
    expect(checkpoints[0].messages.some(isCompactionSummaryMessage)).toBe(true);

    agent.setMode("default");
    expect(projectMessages(agent.messages).some(m => String(m.content).includes(marker))).toBe(false);
    const reopened = new SessionManager(file).getMessages();
    expect(JSON.stringify(projectMessages(reopened))).not.toContain(marker);
  });

  it("defers a checkpoint until both sibling results are real, then preserves the continuation on replay", async () => {
    const requests: Message[][] = [];
    const firstOutput = "actual first result: " + "payload ".repeat(2500);
    const secondOutput = "actual second result";
    let executions = 0;
    let fixtureState: ReturnType<typeof fixture>;
    const provider: Provider = {
      async *streamChat(messages) {
        requests.push(structuredClone(messages));
        if (requests.length === 1) {
          expect(budget(fixtureState.agent.messages).shouldCompact).toBe(false);
          for (const id of ["a", "b"]) {
            yield { type: "tool_call", id, name: "sample", arguments: "{}", isStart: true, isEnd: true };
          }
        } else {
          expect(fixtureState.checkpoints).toHaveLength(1);
          yield { type: "text", content: "Trailing assistant answer" };
        }
        yield { type: "done" };
      },
      async complete() { throw new Error("Unexpected model compaction"); },
    };
    const tool: ToolRegistryEntry = {
      name: "sample", description: "Return sample output", parameters: { type: "object", properties: {} },
      async execute() {
        executions++;
        if (executions === 2) {
          expect(budget(fixtureState.agent.messages).shouldCompact).toBe(true);
          expect(fixtureState.checkpoints).toHaveLength(0);
          // External/public callers must also be unable to checkpoint an unfinished batch.
          fixtureState.agent.compactResidentHistory();
          expect(fixtureState.checkpoints).toHaveLength(0);
        }
        return { content: executions === 1 ? firstOutput : secondOutput };
      },
    };
    fixtureState = fixture(history(3000), provider, [tool]);
    const { agent, file, checkpoints } = fixtureState;
    const events = [];
    for await (const event of agent.run("Use both tools then answer", dirs.at(-1)!)) events.push(event);
    expect(executions).toBe(2);
    expect(requests).toHaveLength(2);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].reason).toBe("resident");
    expect(events.some(e => e.type === "context_compaction" && e.status === "completed")).toBe(true);
    for (const messages of [checkpoints[0].messages, requests[1], agent.messages, new SessionManager(file).getMessages()]) {
      expect(messages.filter(m => m.role === "tool").map(m => m.content)).toEqual([firstOutput, secondOutput]);
      expect(JSON.stringify(messages)).not.toContain("no result captured");
    }
    expect(new SessionManager(file).getMessages().at(-1)).toMatchObject({ role: "assistant", content: "Trailing assistant answer" });
  });

  it("guards all resident entry points while a canonical tool group is incomplete", () => {
    const { agent, checkpoints } = fixture(history(8000));
    agent.messages.push({ role: "assistant", content: "", toolCalls: [
      { id: "a", name: "read", arguments: "{}" }, { id: "b", name: "read", arguments: "{}" },
    ] }, { role: "tool", toolCallId: "a", content: "real a" });
    const before = structuredClone(agent.messages);
    expect(budget(before).shouldCompact).toBe(true);
    agent.compactResidentHistory();
    expect(checkpoints).toHaveLength(0);
    expect(agent.messages).toEqual(before);
    agent.messages.push({ role: "tool", toolCallId: "b", content: "real b" });
    agent.compactResidentHistory();
    expect(checkpoints).toHaveLength(1);
  });
});

describe("checkpoint runtime projection backstop", () => {
  it("filters whole runtime blocks but preserves summary carriers and user prose verbatim", () => {
    const reminder = formatInternalReminderBlock("system-reminder", "runtime only");
    const context = formatInternalContextBlock("runtime-context", "runtime only");
    const summaries: Message[] = [
      buildCompactionSummaryMessage("saved summary"),
      { role: "meta", kind: "subturn-compaction-summary", content: "saved subturn" },
      { role: "user", content: formatInternalContextBlock("compaction-summary", "saved projected summary") },
      { role: "user", content: formatInternalContextBlock("subturn-compaction-summary", "saved projected subturn") },
      { role: "user", content: formatInternalContextBlock("runtime-system", "Previous conversation summary:\nlegacy") },
      { role: "user", content: "Another language model previously worked on this task: saved LLM summary" },
    ];
    const prose: Message[] = [
      { role: "user", content: `Explain this: ${reminder}` },
      { role: "user", content: `${reminder}\nKeep this user instruction` },
      { role: "user", content: `${reminder}\nKeep this instruction too\n${context}` },
      { role: "user", content: '<bubble_internal_context kind="example">unterminated user example' },
      { role: "user", content: [{ type: "text", text: context }, { type: "text", text: "user instruction" }] },
    ];
    const result = createContextCheckpoint([
      { role: "system", content: "host prompt" },
      ...summaries, ...prose,
      { role: "meta", kind: "system-reminder", content: "runtime only" },
      { role: "user", content: reminder }, { role: "user", content: context },
    ], "resident");
    expect(result.messages).toEqual([...summaries, ...prose]);
  });
});
