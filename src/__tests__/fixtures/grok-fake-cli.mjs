import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const grokHome = process.env.GROK_HOME;
const cwdIndex = args.indexOf("--cwd");
const workspace = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
if (!grokHome) process.exit(90);
mkdirSync(grokHome, { recursive: true });
const callsPath = join(grokHome, "fake-calls.ndjson");
const log = (entry) => appendFileSync(callsPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

if (args.includes("--version")) {
  process.stdout.write("grok 0.2.93 (fake)\n");
  process.exit(0);
}

if (args.includes("models")) {
  log({ command: "models", args, envKeys: Object.keys(process.env).sort() });
  process.stdout.write("You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n  - grok-composer-2.5-fast\n");
  process.exit(0);
}

if (args.includes("inspect")) {
  log({ command: "inspect", args, envKeys: Object.keys(process.env).sort() });
  const unsafe = existsSync(join(grokHome, "unsafe-inspect"));
  const unsafePermissionSource = existsSync(join(grokHome, "unsafe-permission-source"));
  const unsafePermissionObjectSource = existsSync(join(grokHome, "unsafe-permission-object-source"));
  const claudeSettingsPath = join(workspace, ".claude", "settings.local.json");
  const config = readFileSync(join(grokHome, "config.toml"), "utf8");
  const markerEnabled = /\[claude_compat\][\s\S]*?\bimported\s*=\s*true\b/.test(config)
    || process.env._GROK_CLAUDE_MARKER_OVERRIDE === "1";
  const permissionSources = [
    `${join(grokHome, "requirements.toml")} (requirements)`,
    `${join(grokHome, "config.toml")} (config)`,
  ];
  if (unsafePermissionSource || (existsSync(claudeSettingsPath) && !markerEnabled)) {
    permissionSources.push(`${claudeSettingsPath} (settings)`);
  }
  if (unsafePermissionObjectSource) permissionSources.push({ path: claudeSettingsPath });
  const cells = [];
  for (const vendor of ["cursor", "claude"]) {
    for (const surface of ["skills", "rules", "agents", "mcps", "hooks"]) {
      cells.push({ vendor, surface, enabled: unsafe && vendor === "claude" && surface === "hooks" });
    }
  }
  // Real Grok 0.2.93 always lists workspace project skills and compat-scanner
  // MCP discoveries in inspect, even when their loading is disabled. Tests
  // drop a project-skills.json / compat-mcp / rogue-mcp marker to emulate a
  // contaminated workspace; skills only appear when the inspected cwd covers
  // their path, mirroring real project discovery.
  const skillsMarker = join(grokHome, "project-skills.json");
  const projectSkills = existsSync(skillsMarker)
    ? JSON.parse(readFileSync(skillsMarker, "utf8")).filter(
        (skill) => skill.anywhere || (skill.path ?? "").startsWith(`${workspace}/`),
      )
    : [];
  const mcpServers = [];
  if (existsSync(join(grokHome, "compat-mcp"))) {
    mcpServers.push({
      name: "fake-cursor-server",
      transport: "stdio",
      vendor: "cursor",
      source: { type: "mcpJson", path: join(workspace, ".cursor", "mcp.json") },
    });
  }
  if (existsSync(join(grokHome, "rogue-mcp"))) {
    mcpServers.push({
      name: "rogue-server",
      transport: "stdio",
      source: { type: "mcpJson", path: join(workspace, ".grok", "mcp.json") },
    });
  }
  const payload = {
    grokVersion: "0.2.93",
    cwd: workspace,
    projectRoot: null,
    projectInstructions: [],
    permissions: {
      sources: permissionSources,
      loaded: permissionSources.length,
      skipped: [],
    },
    hooks: unsafe ? [{ source: "/Users/example/.claude/hooks.json" }] : [],
    skills: projectSkills.map((skill) => ({
      name: skill.name,
      description: "fake project skill",
      source: { type: skill.sourceType ?? "project", path: skill.path },
      userInvocable: true,
    })),
    plugins: [],
    marketplaces: [],
    mcpServers,
    lspServers: [],
    configSources: {
      layers: [
        { path: join(grokHome, "config.toml") },
        { path: join(grokHome, "requirements.toml") },
      ],
    },
    externalCompat: { cells },
  };
  if (existsSync(join(grokHome, "oversized-inspect"))) {
    payload.padding = "";
    const empty = JSON.stringify(payload);
    payload.padding = "x".repeat((512 * 1024) - empty.length);
    // The first 512 KiB is complete, valid JSON. An implementation that only
    // truncates (without tracking overflow) would incorrectly accept it.
    await new Promise((resolve) => process.stdout.write(
      `${JSON.stringify(payload)}trailing-output-that-must-fail-closed`,
      resolve,
    ));
  } else {
    await new Promise((resolve) => process.stdout.write(JSON.stringify(payload), resolve));
  }
  process.exit(0);
}

if (args.includes("login")) {
  log({ command: "login", args, envKeys: Object.keys(process.env).sort(), pid: process.pid });
  if (existsSync(join(grokHome, "fail-login"))) {
    mkdirSync(join(grokHome, "docs"), { recursive: true });
    writeFileSync(join(grokHome, "docs", "temporary.txt"), "must be removed", { mode: 0o600 });
    writeFileSync(join(grokHome, "auth.json.lock"), "", { mode: 0o600 });
    process.stderr.write("oauth failed Authorization=Bearer login-secret\n");
    process.exit(7);
  }
  if (existsSync(join(grokHome, "unsafe-login-url"))) {
    process.stdout.write("Do not open https://auth.x.ai/oauth2/authorize?state=bad#fragment access_token=stdout-token-secret\n");
  } else if (existsSync(join(grokHome, "login-url-stderr"))) {
    process.stderr.write("Browser login: https://auth.x.ai/oauth2/authorize?client_id=fake-client&state=stderr-oauth-state-secret\n");
  } else {
    process.stdout.write("Browser login: https://auth.x.ai/oauth2/authorize?client_id=fake-client&state=oauth-state-secret access_token=stdout-token-secret\n");
  }
  if (existsSync(join(grokHome, "slow-login"))) {
    mkdirSync(join(grokHome, "logs"), { recursive: true });
    writeFileSync(join(grokHome, "logs", "oauth.log"), "temporary login log", { mode: 0o600 });
    writeFileSync(join(grokHome, "auth.json.lock"), "", { mode: 0o600 });
    mkdirSync(join(grokHome, "docs"), { recursive: true });
    writeFileSync(join(grokHome, "docs", "oauth.txt"), "temporary auth handoff", { mode: 0o600 });
    writeFileSync(join(process.env.TMPDIR, "oauth-browser.log"), "temporary browser log", { mode: 0o600 });
    setInterval(() => undefined, 1_000);
    await new Promise(() => undefined);
  } else {
    writeFileSync(join(grokHome, "auth.json"), JSON.stringify({ fake: "credential-never-read-by-bubble" }), { mode: 0o600 });
    process.exit(0);
  }
}

if (args.includes("logout")) {
  log({ command: "logout", args, envKeys: Object.keys(process.env).sort() });
  rmSync(join(grokHome, "auth.json"), { force: true });
  process.exit(0);
}

if (!args.includes("agent") || !args.includes("stdio")) process.exit(91);
mkdirSync(join(grokHome, "skills", "help"), { recursive: true });
writeFileSync(join(grokHome, "skills", "help", "SKILL.md"), "# generated fake skill\n", { mode: 0o600 });
log({ command: "agent-stdio", args, envKeys: Object.keys(process.env).sort() });

let nextSession = 1;
let currentModelId = "grok-4.5";
const modelState = () => ({
  currentModelId,
  availableModels: [
    { modelId: "grok-4.5", name: "Grok 4.5" },
    { modelId: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast" },
  ],
});
const pendingPrompts = new Map();
const lateCancelSessions = new Set();
let pendingPermissionSession;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sessionUpdate = (sessionId, update, meta) => notify("session/update", {
  sessionId,
  update,
  ...(meta ? { _meta: meta } : {}),
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    log({ acp: "initialize", params: message.params });
    if (existsSync(join(grokHome, "initialize-available"))) {
      sessionUpdate("initializing", { sessionUpdate: "available_commands_update", availableCommands: [] });
    }
    if (existsSync(join(grokHome, "initialize-plan"))) {
      sessionUpdate("initializing", { sessionUpdate: "plan", entries: [] });
    }
    if (existsSync(join(grokHome, "initialize-permission"))) {
      send({
        jsonrpc: "2.0",
        id: 902,
        method: "session/request_permission",
        params: {
          sessionId: "initializing",
          toolCall: { toolCallId: "tool-init", title: "forbidden during initialize" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });
    }
    result(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: !existsSync(join(grokHome, "missing-load-capability")),
      },
      authMethods: existsSync(join(grokHome, "missing-cached-auth"))
        ? [{ id: "grok.com", name: "Grok.com" }]
        : [
            { id: "cached_token", name: "Cached Grok login" },
            { id: "grok.com", name: "Grok.com" },
          ],
      agentInfo: { name: "grok-fake", version: "0.2.93" },
    });
  } else if (message.method === "authenticate") {
    log({ acp: "authenticate", params: message.params });
    result(message.id, {});
  } else if (message.method === "session/new") {
    log({ acp: "session/new", params: message.params });
    result(message.id, { sessionId: `fake-session-${nextSession++}`, models: modelState() });
  } else if (message.method === "session/load") {
    log({ acp: "session/load", params: message.params });
    if (existsSync(join(grokHome, "fail-load"))) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "synthetic load failure" },
      });
      return;
    }
    if (message.params.sessionId === "__load_available__") {
      sessionUpdate(message.params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] });
    } else if (message.params.sessionId === "__load_replay__") {
      sessionUpdate(message.params.sessionId, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "replayed-user-secret" },
      });
      sessionUpdate(message.params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed-assistant-secret" },
      });
      sessionUpdate(message.params.sessionId, {
        sessionUpdate: "usage_update",
        used: 1,
        size: 10,
      });
    } else if (message.params.sessionId === "__load_plan__") {
      sessionUpdate(message.params.sessionId, { sessionUpdate: "plan", entries: [] });
    } else if (message.params.sessionId === "__load_tool__") {
      sessionUpdate(message.params.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tool-load",
        title: "forbidden during load",
        status: "pending",
      });
    }
      result(message.id, { models: modelState() });
  } else if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    const text = message.params.prompt?.find((part) => part.type === "text")?.text ?? "";
    log({ acp: "session/prompt", sessionId, text, meta: message.params._meta });
    if (text === "__crash__") {
      process.stderr.write("Authorization=Bearer super-secret-token XAI_API_KEY=xai-secret {\"refresh_token\":\"refresh-secret\"} https://example.test/?access_token=url-secret\n");
      setTimeout(() => process.exit(23), 5);
    } else if (text === "__oversized_acp__") {
      pendingPrompts.set(sessionId, message.id);
      process.stdout.write(`${"x".repeat((1024 * 1024) + 1)} raw-oversized-secret\n`);
    } else if (text === "__malformed_acp__") {
      pendingPrompts.set(sessionId, message.id);
      process.stdout.write("not-json raw-malformed-secret\n");
    } else if (text === "__non_jsonrpc__") {
      pendingPrompts.set(sessionId, message.id);
      process.stdout.write('{"secret":"raw-nonrpc-secret"}\n');
    } else if (text === "__unsolicited_response__") {
      result("raw-unsolicited-secret", {});
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "safe" },
      });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__fs_request__") {
      pendingPrompts.set(sessionId, message.id);
      send({
        jsonrpc: "2.0",
        id: 901,
        method: "fs/read_text_file",
        params: { sessionId, path: "/host/file-that-must-not-be-read" },
      });
    } else if (text === "__permission__") {
      pendingPrompts.set(sessionId, message.id);
      pendingPermissionSession = sessionId;
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "forbidden" },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });
    } else if (text === "__tool__") {
      sessionUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "forbidden",
        status: "pending",
        kind: "read",
        rawInput: { path: "package.json" },
      });
      sessionUpdate(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "tool complete",
      });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__tool_incomplete__") {
      sessionUpdate(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "incomplete",
        status: "pending",
        kind: "read",
        rawInput: { path: "stale.txt" },
      });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__unknown__") {
      pendingPrompts.set(sessionId, message.id);
      sessionUpdate(sessionId, {
        sessionUpdate: "plan",
        entries: [],
      });
    } else if (text === "__cancel_wait__") {
      pendingPrompts.set(sessionId, message.id);
    } else if (text === "__cancel_late_delta__") {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "queued-before-cancel" },
      });
      pendingPrompts.set(sessionId, message.id);
      lateCancelSessions.add(sessionId);
    } else if (text === "__provider_cancelled__") {
      result(message.id, { stopReason: "cancelled" });
    } else if (text === "__available_commands__") {
      sessionUpdate(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compress conversation history", input: { hint: "context" } },
        ],
      });
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "safe-after-metadata" },
      });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__skill_command__") {
      pendingPrompts.set(sessionId, message.id);
      sessionUpdate(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "compact", description: "Compress conversation history", input: { hint: "context" } },
          {
            name: "sneaky-skill",
            description: "workspace skill that escaped the disabled list",
            input: null,
            _meta: { scope: "local", path: join(workspace, ".grok", "skills", "sneaky-skill", "SKILL.md") },
          },
        ],
      });
    } else if (text === "__generation__") {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale" },
      }, { generation: 1 });
      sessionUpdate("wrong-session", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "wrong" },
      }, { generation: 2 });
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fresh" },
      }, { generation: 2 });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__session_isolation__") {
      const otherSessionId = sessionId === "fake-session-1" ? "fake-session-2" : "fake-session-1";
      sessionUpdate(otherSessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "other-session" },
      });
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "active-session" },
      });
      result(message.id, { stopReason: "end_turn" });
    } else if (text === "__late_start__") {
      result(message.id, { stopReason: "end_turn" });
      setTimeout(() => sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late-stale" },
      }), 15);
    } else if (text === "__late_receive__") {
      const generation = message.params._meta?.bubbleGeneration;
      setTimeout(() => {
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "current" },
        }, { bubbleGeneration: generation });
        result(message.id, { stopReason: "end_turn" });
      }, 40);
    } else {
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      });
      sessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      });
      result(message.id, { stopReason: "end_turn" });
    }
  } else if (message.method === "session/set_model") {
    log({ acp: "session/set_model", params: message.params });
    if (!["grok-4.5", "grok-composer-2.5-fast"].includes(message.params.modelId)) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "unknown model" } });
    } else {
      currentModelId = message.params.modelId;
      result(message.id, { models: modelState() });
    }
  } else if (message.method === "session/cancel") {
    const sessionId = message.params.sessionId;
    log({ acp: "session/cancel", sessionId });
    const promptId = pendingPrompts.get(sessionId);
    if (promptId !== undefined) {
      pendingPrompts.delete(sessionId);
      if (lateCancelSessions.delete(sessionId)) {
        sessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late-after-cancel" },
        });
      }
      result(promptId, { stopReason: "cancelled" });
    }
  } else if (message.id === 900) {
    log({ acp: "permission-response", result: message.result });
    if (pendingPermissionSession) {
      const promptId = pendingPrompts.get(pendingPermissionSession);
      pendingPrompts.delete(pendingPermissionSession);
      pendingPermissionSession = undefined;
      if (promptId !== undefined) result(promptId, { stopReason: "end_turn" });
    }
  } else if (message.id === 901) {
    log({ acp: "host-capability-response", result: message.result, error: message.error });
  } else if (message.id === 902) {
    log({ acp: "initialize-permission-response", result: message.result, error: message.error });
  }
});
