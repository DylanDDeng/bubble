import { describe, expect, it } from "vitest";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";

describe("arbitrateToolCall", () => {
  it("rewrites simple bash grep searches to the grep tool", () => {
    const result = arbitrateToolCall({
      id: "1",
      name: "bash",
      arguments: "{\"command\":\"grep -R \\\"API_KEY\\\" src\"}",
      parsedArgs: {
        command: "grep -R \"API_KEY\" src",
      },
    });

    expect(result.toolCall.name).toBe("grep");
    expect(result.toolCall.parsedArgs).toEqual({
      pattern: "API_KEY",
      path: "src",
    });
    expect(result.note).toContain("Rewrote bash search to grep");
  });

  it("leaves general bash commands untouched", () => {
    const result = arbitrateToolCall({
      id: "1",
      name: "bash",
      arguments: "{\"command\":\"npm test\"}",
      parsedArgs: {
        command: "npm test",
      },
    });

    expect(result.toolCall.name).toBe("bash");
    expect(result.note).toBeUndefined();
  });
});
