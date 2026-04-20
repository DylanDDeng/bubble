import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../mcp/config.js";

function writeJson(path: string, data: unknown) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

describe("loadMcpConfig", () => {
  let bubbleHome: string;
  let projectCwd: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    bubbleHome = mkdtempSync(join(tmpdir(), "bubble-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "bubble-proj-"));
    savedEnv = process.env.MY_TOKEN;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MY_TOKEN;
    else process.env.MY_TOKEN = savedEnv;
  });

  it("reads stdio + http servers and normalizes optional fields", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      mcpServers: {
        github: { type: "stdio", command: "npx", args: ["-y", "server-github"] },
        exa: { type: "http", url: "https://mcp.example/mcp", headers: { "X-Key": "v" } },
      },
    });

    const { servers, diagnostics } = loadMcpConfig({ cwd: projectCwd, bubbleHome });
    expect(diagnostics).toEqual([]);
    expect(servers).toHaveLength(2);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.github.config.type).toBe("stdio");
    expect(byName.exa.config.type).toBe("http");
  });

  it("project scope overrides user scope, local overrides both", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      mcpServers: { same: { type: "stdio", command: "USER" } },
    });
    writeJson(join(projectCwd, ".bubble", "settings.json"), {
      mcpServers: { same: { type: "stdio", command: "PROJECT" } },
    });
    writeJson(join(projectCwd, ".bubble", "settings.local.json"), {
      mcpServers: { same: { type: "stdio", command: "LOCAL" } },
    });

    const { servers, diagnostics } = loadMcpConfig({ cwd: projectCwd, bubbleHome });
    expect(servers).toHaveLength(1);
    expect(servers[0].scope).toBe("local");
    if (servers[0].config.type !== "stdio") throw new Error("expected stdio");
    expect(servers[0].config.command).toBe("LOCAL");
    // Two override diagnostics: project-over-user, local-over-project.
    expect(diagnostics.filter((d) => d.message.includes("overrides"))).toHaveLength(2);
  });

  it("expands ${ENV} in command / args / env / url / headers", () => {
    process.env.MY_TOKEN = "SEKRIT";
    writeJson(join(bubbleHome, "settings.json"), {
      mcpServers: {
        a: { type: "stdio", command: "x", args: ["--tok=${MY_TOKEN}"], env: { TOKEN: "${MY_TOKEN}" } },
        b: {
          type: "http",
          url: "https://api.example/?k=${MY_TOKEN}",
          headers: { Authorization: "Bearer ${MY_TOKEN}" },
        },
      },
    });

    const { servers } = loadMcpConfig({ cwd: projectCwd, bubbleHome });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    if (byName.a.config.type !== "stdio") throw new Error("expected stdio");
    expect(byName.a.config.args?.[0]).toBe("--tok=SEKRIT");
    expect(byName.a.config.env?.TOKEN).toBe("SEKRIT");
    if (byName.b.config.type !== "http") throw new Error("expected http");
    expect(byName.b.config.url).toBe("https://api.example/?k=SEKRIT");
    expect(byName.b.config.headers?.Authorization).toBe("Bearer SEKRIT");
  });

  it("reports diagnostics for unknown transport and missing command", () => {
    writeJson(join(bubbleHome, "settings.json"), {
      mcpServers: {
        bad1: { type: "weird", url: "x" },
        bad2: { type: "stdio" },
      },
    });
    const { servers, diagnostics } = loadMcpConfig({ cwd: projectCwd, bubbleHome });
    expect(servers).toHaveLength(0);
    expect(diagnostics).toHaveLength(2);
  });
});
