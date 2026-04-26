import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { gateToolAction } from "../approval/tool-helper.js";
import type { ApprovalController } from "../approval/types.js";
import { getLspService, type LspService } from "../lsp/index.js";
import type { ToolRegistryEntry } from "../types.js";

const OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

type LspOperation = (typeof OPERATIONS)[number];

export function createLspTool(
  cwd: string,
  lsp: LspService = getLspService(cwd),
  approval?: ApprovalController,
): ToolRegistryEntry {
  return {
    name: "lsp",
    readOnly: true,
    description:
      "Use the language server for code navigation. Supports goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, and outgoingCalls.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...OPERATIONS], description: "LSP operation to perform" },
        filePath: { type: "string", description: "Path to the file, relative or absolute" },
        line: { type: "number", description: "1-based line number for position-based operations" },
        character: { type: "number", description: "1-based character offset for position-based operations" },
        query: { type: "string", description: "Optional query for workspaceSymbol" },
      },
      required: ["operation", "filePath"],
    },
    async execute(args) {
      const operation = args.operation as LspOperation;
      if (!OPERATIONS.includes(operation)) {
        return { content: `Error: Unsupported LSP operation: ${args.operation}`, isError: true };
      }

      const file = resolve(cwd, String(args.filePath));
      try {
        await access(file, constants.R_OK);
      } catch {
        return { content: `Error: File not found or not readable: ${file}`, isError: true };
      }

      const available = await lsp.hasClients(file);
      if (!available) {
        return { content: "Error: No LSP server available for this file type.", isError: true };
      }

      const gate = await gateToolAction(approval, {
        type: "lsp",
        path: file,
        operation,
      });
      if (!gate.approved) return gate.result;

      await lsp.touchFile(file, "document");
      const position = {
        file,
        line: Math.max(0, Number(args.line ?? 1) - 1),
        character: Math.max(0, Number(args.character ?? 1) - 1),
      };

      const result = await runOperation(lsp, operation, position, String(args.query ?? ""));
      return {
        content: result.length === 0 ? `No results found for ${operation}` : JSON.stringify(result, null, 2),
        status: "success",
        metadata: { kind: "lsp", path: file },
      };
    },
  };
}

async function runOperation(
  lsp: LspService,
  operation: LspOperation,
  position: { file: string; line: number; character: number },
  query: string,
): Promise<unknown[]> {
  switch (operation) {
    case "goToDefinition":
      return lsp.definition(position);
    case "findReferences":
      return lsp.references(position);
    case "hover":
      return lsp.hover(position);
    case "documentSymbol":
      return lsp.documentSymbol(position.file);
    case "workspaceSymbol":
      return lsp.workspaceSymbol(query);
    case "goToImplementation":
      return lsp.implementation(position);
    case "prepareCallHierarchy":
      return lsp.prepareCallHierarchy(position);
    case "incomingCalls":
      return lsp.incomingCalls(position);
    case "outgoingCalls":
      return lsp.outgoingCalls(position);
  }
}
