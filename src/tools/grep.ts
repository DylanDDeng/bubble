/**
 * Grep tool - search file contents using ripgrep.
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ToolRegistryEntry, ToolResult } from "../types.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { analyzeToolIntent } from "../agent/tool-intent.js";

const MAX_MATCHES = 100;

export function createGrepTool(cwd: string): ToolRegistryEntry {
  return {
    name: "grep",
    readOnly: true,
    description: `Search file contents using regex (via ripgrep). Use this instead of running grep, rg, or ripgrep through bash. Returns up to ${MAX_MATCHES} matches.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (optional, default: cwd)" },
        glob: { type: "string", description: "Glob pattern to filter files (optional, e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
    async execute(args): Promise<ToolResult> {
      const searchPath = args.path ? resolve(cwd, args.path) : cwd;
      const pattern = String(args.pattern);
      const intent = analyzeToolIntent({
        name: "grep",
        parsedArgs: {
          pattern,
          path: args.path,
          glob: args.glob,
        },
      });

      if (isSensitivePath(searchPath)) {
        return {
          content: `Error: Search blocked for sensitive credential storage: ${searchPath}`,
          isError: true,
          status: "blocked",
          metadata: {
            kind: "security",
            path: searchPath,
            pattern,
            searchSignature: intent.search?.signature,
            searchFamily: intent.search?.familyKey,
            reason: "Sensitive credential storage is not searchable from general-purpose tasks.",
          },
        };
      }

      const rgArgs = ["--json", "-n", "--max-count", String(MAX_MATCHES), pattern];
      if (args.glob) {
        rgArgs.push("--glob", String(args.glob));
      }
      rgArgs.push(searchPath);

      return new Promise((resolve) => {
        execFile("rg", rgArgs, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          // rg returns exit code 1 when no matches found, which is not an error for us
          const lines = stdout.split("\n").filter((l) => l.trim() !== "");
          const matches: string[] = [];

          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === "match") {
                const path = obj.data.path.text;
                const lineNum = obj.data.line_number;
                const text = obj.data.lines.text?.trim() ?? "";
                matches.push(`${path}:${lineNum}: ${text}`);
              }
            } catch {
              // ignore parse errors
            }
          }

          if (matches.length === 0) {
            resolve({
              content: "No matches found.",
              status: "no_match",
              metadata: {
                kind: "search",
                path: searchPath,
                pattern,
                matches: 0,
                truncated: false,
                searchSignature: intent.search?.signature,
                searchFamily: intent.search?.familyKey,
              },
            });
            return;
          }

          let output = matches.join("\n");
          const truncated = matches.length >= MAX_MATCHES;
          if (matches.length >= MAX_MATCHES) {
            output += `\n[More than ${MAX_MATCHES} matches, output truncated]`;
          }
          resolve({
            content: output,
            status: truncated ? "partial" : "success",
            metadata: {
              kind: "search",
              path: searchPath,
              pattern,
              matches: matches.length,
              truncated,
              searchSignature: intent.search?.signature,
              searchFamily: intent.search?.familyKey,
            },
          });
        });
      });
    },
  };
}
