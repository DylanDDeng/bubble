import { describe, expect, it } from "vitest";
import { filterToolsForSubtask, getSubtaskPolicy } from "../agent/subtask-policy.js";
import type { ToolRegistryEntry } from "../types.js";

const TOOLS: ToolRegistryEntry[] = [
  { name: "read", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }), readOnly: true },
  { name: "glob", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }), readOnly: true },
  { name: "grep", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }), readOnly: true },
  { name: "bash", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }) },
  { name: "task", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }), readOnly: true },
  { name: "skill", description: "", parameters: { type: "object", properties: {} }, execute: async () => ({ content: "" }), readOnly: true },
];

describe("subtask policy", () => {
  it("filters tools according to the subtask type", () => {
    const filtered = filterToolsForSubtask(TOOLS, "evidence_correlation");
    expect(filtered.map((tool) => tool.name)).toEqual(["read", "skill"]);
  });

  it("returns a stable default policy", () => {
    const policy = getSubtaskPolicy(undefined);
    expect(policy.type).toBe("general_readonly");
    expect(policy.allowedTools).toContain("read");
    expect(policy.allowedTools).toContain("glob");
  });
});
