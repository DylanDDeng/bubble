import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LspService } from "../../lsp/index.js";
import { createLspTool } from "../lsp.js";
import { createWriteTool } from "../write.js";

function fakeLsp(overrides: Partial<LspService> = {}): LspService {
  return {
    onStatusChange: () => () => undefined,
    isDisabled: () => false,
    updateConfig: () => undefined,
    restart: async () => undefined,
    status: () => [],
    hasClients: async () => true,
    touchFile: async () => undefined,
    diagnostics: () => ({}),
    hover: async () => [],
    definition: async () => [],
    references: async () => [],
    implementation: async () => [],
    documentSymbol: async () => [],
    workspaceSymbol: async () => [],
    prepareCallHierarchy: async () => [],
    incomingCalls: async () => [],
    outgoingCalls: async () => [],
    ...overrides,
  };
}

describe("lsp tool", () => {
  it("runs position based operations through the LSP service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-lsp-tool-"));
    const file = join(dir, "example.ts");
    writeFileSync(file, "export const value = 1;\n", "utf-8");
    const tool = createLspTool(dir, fakeLsp({
      hover: async (input) => [{ file: input.file, line: input.line, character: input.character }],
    }));

    const result = await tool.execute(
      { operation: "hover", filePath: "example.ts", line: 1, character: 8 },
      { cwd: dir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("\"line\": 0");
    expect(result.content).toContain("\"character\": 7");
  });

  it("runs call hierarchy operations through the LSP service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-lsp-call-"));
    writeFileSync(join(dir, "example.ts"), "function a() {}\n", "utf-8");
    const tool = createLspTool(dir, fakeLsp({
      incomingCalls: async () => [{ from: { name: "caller" } }],
    }));

    const result = await tool.execute(
      { operation: "incomingCalls", filePath: "example.ts", line: 1, character: 10 },
      { cwd: dir },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("caller");
  });

  it("reports unavailable when LSP is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-lsp-disabled-"));
    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n", "utf-8");
    const tool = createLspTool(dir, fakeLsp({
      isDisabled: () => true,
      hasClients: async () => false,
    }));

    const result = await tool.execute(
      { operation: "hover", filePath: "example.ts", line: 1, character: 8 },
      { cwd: dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("No LSP server available");
  });

  it("asks approval before executing an LSP operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-lsp-approval-"));
    writeFileSync(join(dir, "example.ts"), "export const value = 1;\n", "utf-8");
    const request = vi.fn(async () => ({ action: "reject" as const, feedback: "no" }));
    const tool = createLspTool(dir, fakeLsp(), {
      request,
      checkRules: () => ({ decision: "ask" }),
    });

    const result = await tool.execute(
      { operation: "hover", filePath: "example.ts", line: 1, character: 8 },
      { cwd: dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("LSP hover");
    expect(request).toHaveBeenCalledWith({
      type: "lsp",
      path: join(dir, "example.ts"),
      operation: "hover",
    });
  });

  it("reports diagnostics after write when an LSP service is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bubble-lsp-write-"));
    const file = join(dir, "bad.ts");
    const tool = createWriteTool(dir, { refuseOverwrite: false }, undefined, fakeLsp({
      diagnostics: () => ({
        [file]: [{
          message: "Type 'string' is not assignable to type 'number'.",
          severity: 1,
          source: "typescript",
          range: { start: { line: 0, character: 6 } },
        }],
      }),
    }));

    const result = await tool.execute(
      { path: "bad.ts", content: "const x: number = 'oops';\n" },
      { cwd: dir },
    );

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toContain("'oops'");
    expect(result.content).toContain("LSP diagnostics in this file");
    expect(result.content).toContain("bad.ts:1:7 error typescript");
  });
});
