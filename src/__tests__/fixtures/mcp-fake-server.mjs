#!/usr/bin/env node
/**
 * Minimal MCP stdio server for tests. Implements:
 *   - initialize
 *   - notifications/initialized (ignored)
 *   - tools/list → single `echo` tool
 *   - tools/call echo → returns back what you sent
 *
 * Line-delimited JSON-RPC on stdin/stdout.
 */

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "fake-stdio", version: "1.0.0" },
      },
    });
    return;
  }

  if (req.method === "notifications/initialized") {
    return;
  }

  if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo a string",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }

  if (req.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        prompts: [
          {
            name: "greet",
            description: "Produce a greeting for the named person",
            arguments: [
              { name: "person", description: "Who to greet", required: true },
              { name: "style", description: "Tone (formal/casual)", required: false },
            ],
          },
        ],
      },
    });
    return;
  }

  if (req.method === "prompts/get") {
    const { name, arguments: args = {} } = req.params ?? {};
    if (name === "greet") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Hello ${args.person}! (${args.style || "casual"})` },
            },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32602, message: `Unknown prompt ${name}` },
    });
    return;
  }

  if (req.method === "tools/call") {
    const text = req.params?.arguments?.text ?? "";
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        content: [{ type: "text", text: `echo:${text}` }],
      },
    });
    return;
  }

  if ("id" in req) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown method ${req.method}` },
    });
  }
});
