import { describe, expect, it } from "vitest";
import { arbitrateToolCall } from "../agent/tool-arbiter.js";
import { parseSearchBashCommand } from "../agent/tool-intent.js";

function bashCall(command: string) {
  return {
    id: "1",
    name: "bash",
    arguments: JSON.stringify({ command }),
    parsedArgs: { command },
  };
}

describe("arbitrateToolCall", () => {
  it("rewrites a bare rg search to the grep tool (provably lossless: the tool shells out to rg)", () => {
    const result = arbitrateToolCall(bashCall('rg "API_KEY" src'));

    expect(result.toolCall.name).toBe("grep");
    expect(result.toolCall.parsedArgs).toEqual({
      pattern: "API_KEY",
      path: "src",
    });
    expect(result.note).toContain("Rewrote bash search to grep");
  });

  it("keeps --glob in the rewrite (1:1 mapping onto the tool's glob)", () => {
    const result = arbitrateToolCall(bashCall("rg --glob '*.ts' handleClick"));

    expect(result.toolCall.name).toBe("grep");
    expect(result.toolCall.parsedArgs).toEqual({
      pattern: "handleClick",
      glob: "*.ts",
    });
  });

  it("passes through rg with flags the tool cannot express, verbatim", () => {
    // -i (case-insensitive) has no representation in the structured tool;
    // rewriting used to drop it silently, so `rg -i apikey` missed apiKey.
    for (const command of [
      'rg -i "apikey" src',
      'rg -A 3 "foo" src',
      'rg -w "env"',
      'rg -l "foo" src',
      "rg --iglob '*.TS' foo",     // case-insensitive glob would be lost
      "rg --include '*.ts' foo",   // not an rg flag; a faithful run errors
      'rg "foo" src lib',          // multiple search roots
    ]) {
      const result = arbitrateToolCall(bashCall(command));
      expect(result.toolCall.name, command).toBe("bash");
      expect(result.toolCall.parsedArgs.command, command).toBe(command);
      expect(result.note, command).toBeUndefined();
    }
  });

  it("passes through GNU grep commands (BRE dialect must not run under the tool's rg engine)", () => {
    for (const command of [
      'grep -R "API_KEY" src',
      'grep "a\\+b" src',
      'grep "API_KEY" file.txt',
    ]) {
      const result = arbitrateToolCall(bashCall(command));
      expect(result.toolCall.name, command).toBe("bash");
      expect(result.note, command).toBeUndefined();
    }
  });

  it("leaves general bash commands untouched", () => {
    const result = arbitrateToolCall(bashCall("npm test"));

    expect(result.toolCall.name).toBe("bash");
    expect(result.note).toBeUndefined();
  });

  it("leaves piped search commands untouched", () => {
    const result = arbitrateToolCall(bashCall('rg "foo" src | head -20'));

    expect(result.toolCall.name).toBe("bash");
    expect(result.note).toBeUndefined();
  });
});

describe("parseSearchBashCommand lossless flag", () => {
  it("marks bare rg as lossless and flagged rg as lossy, keeping the parse for observation", () => {
    expect(parseSearchBashCommand("rg foo src")?.lossless).toBe(true);
    expect(parseSearchBashCommand("rg --glob '*.ts' foo")?.lossless).toBe(true);

    const lossy = parseSearchBashCommand("rg -i foo src");
    // Observation still classifies it as a search with the right pattern...
    expect(lossy?.pattern).toBe("foo");
    expect(lossy?.path).toBe("src");
    // ...but execution rewriting must refuse it.
    expect(lossy?.lossless).toBe(false);
  });

  it("marks the grep binary lossy regardless of flags", () => {
    expect(parseSearchBashCommand("grep foo src")?.lossless).toBe(false);
  });
});
