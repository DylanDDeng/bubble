import { describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { discoverAgentProfiles, findAgentProfile, type AgentProfile } from "../agent/profiles.js";
import {
  appendOutputSchemaInstructions,
  extractJson,
  validateStructuredSummary,
} from "../agent/structured-output.js";
import { isolateReadonlyChildFileTools } from "../tools/child-tools.js";
import { createReadTool } from "../tools/read.js";
import type { Provider, StreamChunk, ToolRegistryEntry, ToolUpdate } from "../types.js";

const LONG = "Complete handoff with concrete file-level evidence and conclusions. ".repeat(4);

function defaultProfile(): AgentProfile {
  return findAgentProfile(discoverAgentProfiles("/tmp", "user").profiles, "default")!;
}

function textProvider(summary = LONG): Provider {
  return {
    async *streamChat() {
      yield { type: "text", content: summary } satisfies StreamChunk;
      yield { type: "done" } satisfies StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

/** Provider whose response changes per call (for schema-retry tests). */
function scriptedProvider(responses: string[]): Provider {
  let call = 0;
  return {
    async *streamChat() {
      const content = responses[Math.min(call, responses.length - 1)];
      call += 1;
      yield { type: "text", content } satisfies StreamChunk;
      yield { type: "done" } satisfies StreamChunk;
    },
    async complete() {
      return "complete";
    },
  };
}

describe("v2 §1.1 — per-call model/effort override", () => {
  it("spawn_agent routes a child onto a call-named model and effort, beating profile/category defaults", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "spawn_1",
      model: "gpt-4o-mini",
      effort: "high",
    });
    expect(snapshot.route?.model).toBe("gpt-4o-mini");
    expect(snapshot.route?.thinkingLevel).toBe("high");
    expect(snapshot.route?.inherited).toBe(false);
  });

  it("a provider-prefixed model selects cross-provider in the resolved route", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "spawn_1",
      model: "anthropic:claude-opus-4-1",
    });
    expect(snapshot.route?.providerId).toBe("anthropic");
    expect(snapshot.route?.model).toBe("claude-opus-4-1");
  });

  it("without an override the child inherits the parent model", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const snapshot = await agent.spawnSubAgent("inspect", "/tmp", {
      profile: defaultProfile(),
      parentToolCallId: "spawn_1",
    });
    expect(snapshot.route?.model).toBe("gpt-4o");
  });
});

describe("v2 §1.3 — agent_batch heterogeneous fan-out", () => {
  it("runs N different specs concurrently, each on its own model, returning results in spec order", async () => {
    const agent = new Agent({ provider: textProvider(), model: "gpt-4o", tools: [] });
    const updates: ToolUpdate[] = [];
    const snapshots = await agent.runAgentBatch("/tmp", {
      specs: [
        { task: "Scout module A", profile: defaultProfile(), model: "gpt-4o-mini", effort: "low" },
        { task: "Synthesize findings", profile: defaultProfile(), model: "gpt-4o", effort: "high" },
      ],
      parentToolCallId: "batch_1",
      emitUpdate: (update) => updates.push(update),
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((s) => s.task)).toEqual(["Scout module A", "Synthesize findings"]);
    expect(snapshots.every((s) => s.status === "completed")).toBe(true);
    expect(snapshots[0].route?.model).toBe("gpt-4o-mini");
    expect(snapshots[0].route?.thinkingLevel).toBe("low");
    expect(snapshots[1].route?.model).toBe("gpt-4o");
    expect(snapshots[1].route?.thinkingLevel).toBe("high");
    // Member events reached the tool's own update channel; both members distinct.
    expect(new Set(updates.map((u) => u.subAgentId)).size).toBe(2);
    expect(snapshots.every((s) => s.deliveredAt !== undefined)).toBe(true);
  });
});

describe("v2 §1.2 — structured output validation", () => {
  const schema = { type: "object", required: ["name", "score"], properties: { name: { type: "string" }, score: { type: "number" } } };

  it("extractJson recovers JSON from raw, fenced, and prose-wrapped summaries", () => {
    expect(extractJson('{"a":1}').ok && (extractJson('{"a":1}') as any).value).toEqual({ a: 1 });
    expect((extractJson("```json\n{\"a\":1}\n```") as any).value).toEqual({ a: 1 });
    expect((extractJson('here is the result: {"a":1} done') as any).value).toEqual({ a: 1 });
    expect(extractJson("no json here").ok).toBe(false);
  });

  it("validateStructuredSummary accepts conforming JSON and rejects type/required violations", () => {
    expect(validateStructuredSummary('{"name":"x","score":3}', schema).ok).toBe(true);
    expect(validateStructuredSummary('{"name":"x"}', schema).ok).toBe(false); // missing required
    expect(validateStructuredSummary('{"name":"x","score":"NaN"}', schema).ok).toBe(false); // wrong type
    expect(validateStructuredSummary("not json", schema).ok).toBe(false);
  });

  it("validates enums and nested array items", () => {
    const s = { type: "array", items: { type: "string", enum: ["a", "b"] } };
    expect(validateStructuredSummary('["a","b","a"]', s).ok).toBe(true);
    expect(validateStructuredSummary('["a","c"]', s).ok).toBe(false);
  });

  it("appendOutputSchemaInstructions embeds the schema and a JSON-only directive", () => {
    const augmented = appendOutputSchemaInstructions("Do the thing.", schema);
    expect(augmented).toContain("Do the thing.");
    expect(augmented).toContain("JSON Schema:");
    expect(augmented).toContain('"required"');
  });

  it("agent_batch retries once when the first summary fails the schema, then returns valid JSON", async () => {
    // First response is non-JSON; the corrective send_input drives the second
    // (valid) response. A pure-text provider means no extra final-summary turn.
    const agent = new Agent({
      provider: scriptedProvider(["sorry, here is prose not json", '{"name":"auth","score":7}']),
      model: "gpt-4o",
      tools: [],
    });
    const snapshots = await agent.runAgentBatch("/tmp", {
      specs: [{ task: "Score module", profile: defaultProfile(), outputSchema: schema }],
      parentToolCallId: "batch_schema",
    });
    expect(snapshots).toHaveLength(1);
    expect(validateStructuredSummary(snapshots[0].summary, schema).ok).toBe(true);
  });
});

describe("v2 §2 — per-child tool isolation", () => {
  it("the standard read tool exposes cloneForChild producing a fresh, distinct instance", () => {
    const read = createReadTool("/tmp");
    expect(typeof read.cloneForChild).toBe("function");
    const clone = read.cloneForChild!();
    expect(clone.name).toBe("read");
    expect(clone).not.toBe(read);
  });

  it("isolateReadonlyChildFileTools clones hooked tools and passes custom/stateless ones through unchanged", () => {
    const read = createReadTool("/tmp");
    const customRead: ToolRegistryEntry = {
      name: "read",
      readOnly: true,
      effect: "read",
      description: "mock",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "mock" };
      },
    };
    const stateless: ToolRegistryEntry = {
      name: "grep",
      effect: "read",
      description: "grep",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: "" };
      },
    };

    const isolatedStandard = isolateReadonlyChildFileTools([read, stateless]);
    expect(isolatedStandard[0]).not.toBe(read); // standard read cloned
    expect(isolatedStandard[1]).toBe(stateless); // stateless passed through

    // A custom read tool without the hook must NOT be clobbered.
    const isolatedCustom = isolateReadonlyChildFileTools([customRead]);
    expect(isolatedCustom[0]).toBe(customRead);
  });
});
