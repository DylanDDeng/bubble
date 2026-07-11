import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../types.js";
import {
  GrokRuntimeError,
  GrokDiagnosticBuffer,
  grokLoginFailureMessage,
  GrokRuntimeManager,
  GROK_ACP_ARGS,
  GROK_CONFIG_TOML,
  GROK_REQUIREMENTS_TOML,
  buildGrokChildEnv,
  getGrokProfile,
  sanitizeGrokDiagnostic,
  sha256File,
  verifyGrokBinary,
  verifyGrokBinaryAncestors,
  type GrokSpawn,
} from "../external-runtime/index.js";

const fixture = fileURLToPath(new URL("./fixtures/grok-fake-cli.mjs", import.meta.url));

const fakeSpawn: GrokSpawn = (command, args, options: SpawnOptions) =>
  nodeSpawn(process.execPath, [command, ...args], { ...options, shell: false });

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("Grok Subscription external runtime", () => {
  let bubbleHome: string;
  let expectedSha256: string;
  let workspace: string;
  const managers: GrokRuntimeManager[] = [];

  beforeEach(async () => {
    bubbleHome = await mkdtemp(join(tmpdir(), "bubble-grok-runtime-"));
    expectedSha256 = await sha256File(fixture);
    workspace = join(bubbleHome, "user-workspace");
    await mkdir(workspace, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(managers.map((manager) => manager.dispose()));
    await rm(bubbleHome, { recursive: true, force: true });
  });

  function manager(overrides: ConstructorParameters<typeof GrokRuntimeManager>[0] = {}): GrokRuntimeManager {
    const instance = new GrokRuntimeManager({
      bubbleHome,
      binaryPath: fixture,
      expectedSha256,
      platform: "darwin",
      arch: "arm64",
      uid: process.getuid?.(),
      spawn: fakeSpawn,
      oauthOpener: vi.fn(async (_url: string, _signal: AbortSignal) => undefined),
      networkResolver: vi.fn(async () => ({ source: "direct" as const })),
      workspace,
      ...overrides,
    });
    managers.push(instance);
    return instance;
  }

  async function readCalls(): Promise<Array<Record<string, any>>> {
    const path = join(getGrokProfile(bubbleHome).grokHome, "fake-calls.ndjson");
    const text = await readFile(path, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  it("constructs lazily without creating a profile or spawning the CLI", async () => {
    manager();
    await expect(stat(getGrokProfile(bubbleHome).root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains when xAI fails before an OAuth URL can be created", () => {
    expect(grokLoginFailureMessage(
      "error sending request for url (https://auth.x.ai/.well-known/openid-configuration): Connection reset by peer",
    )).toContain("no sign-in page was created");
    expect(grokLoginFailureMessage("oauth rejected")).toBe("Grok login did not complete.");
  });

  it("redacts secrets split at every stderr chunk boundary", () => {
    const cases = [
      { text: "Bearer super-secret-token", secret: "super-secret-token" },
      { text: "Authorization: Bearer authorization-secret", secret: "authorization-secret" },
      { text: "https://example.test/cb?token=query-secret", secret: "query-secret" },
      { text: '{"refresh_token":"refresh-secret"}', secret: "refresh-secret" },
    ];

    for (const { text, secret } of cases) {
      for (let boundary = 1; boundary < text.length; boundary++) {
        const diagnostic = new GrokDiagnosticBuffer();
        diagnostic.append(text.slice(0, boundary));
        diagnostic.append(text.slice(boundary));
        expect(diagnostic.sanitized()).not.toContain(secret);
      }
    }
  });

  it("pins platform, version, hash, private profile modes, and an allowlisted child environment", async () => {
    const runtime = manager();
    const initial = await runtime.inspect();
    expect(initial.state).toBe("signed_out");
    expect(initial.binary).toMatchObject({ version: "0.2.93", sha256: expectedSha256 });

    const profile = getGrokProfile(bubbleHome);
    for (const path of [profile.root, profile.home, profile.grokHome, profile.tmp, profile.workspace]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of [profile.configPath, profile.requirementsPath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    const inspectCall = (await readCalls()).find((call) => call.command === "inspect");
    expect(inspectCall).toBeDefined();
    expect(inspectCall!.envKeys).toContain("GROK_HOME");
    expect(inspectCall!.envKeys).not.toContain("XAI_API_KEY");
    expect(inspectCall!.envKeys).not.toContain("HTTPS_PROXY");
    expect(inspectCall!.envKeys).not.toContain("OPENAI_API_KEY");

    const safeBin = join(bubbleHome, "safe-bin");
    const unsafeBin = join(bubbleHome, "unsafe-bin");
    await mkdir(safeBin, { mode: 0o755 });
    await mkdir(unsafeBin, { mode: 0o777 });
    await chmod(unsafeBin, 0o777);
    const childEnv = buildGrokChildEnv(profile, { PATH: `${unsafeBin}:${safeBin}` });
    expect(childEnv.PATH).toBe(safeBin);
    expect(childEnv.GROK_WRITE_FILE).toBe("1");
    expect(childEnv._GROK_CLAUDE_MARKER_OVERRIDE).toBe("1");
    expect(buildGrokChildEnv(profile, { _GROK_CLAUDE_MARKER_OVERRIDE: "0" })
      ._GROK_CLAUDE_MARKER_OVERRIDE).toBe("1");
    for (const contents of [GROK_CONFIG_TOML, GROK_REQUIREMENTS_TOML]) {
      expect(contents).toMatch(/\[claude_compat\]\s+imported\s*=\s*true/);
    }

    const unsupported = manager({ platform: "linux" });
    expect((await unsupported.inspect()).message).toContain("macOS Apple Silicon");
    let untrustedExecuted = false;
    const wrongHash = manager({
      expectedSha256: "0".repeat(64),
      readVersion: async () => {
        untrustedExecuted = true;
        return "grok 0.2.93";
      },
    });
    expect((await wrongHash.inspect()).message).toContain("checksum");
    expect(untrustedExecuted).toBe(false);
  });

  it("rejects missing, wrong-version, wrong-owner, and writable binaries", async () => {
    const missing = manager({ binaryPath: join(bubbleHome, "missing-grok") });
    expect((await missing.inspect()).message).toContain("Install the pinned Grok Build CLI");

    await expect(verifyGrokBinary({
      binaryPath: fixture,
      expectedSha256,
      platform: "darwin",
      arch: "arm64",
      uid: process.getuid?.(),
      readVersion: async () => "grok 0.2.92 (fake)",
    })).rejects.toMatchObject({ code: "binary_version_mismatch" });

    await expect(verifyGrokBinary({
      binaryPath: fixture,
      expectedSha256,
      platform: "darwin",
      arch: "arm64",
      uid: (process.getuid?.() ?? 0) + 1,
      readVersion: async () => "grok 0.2.93 (fake)",
    })).rejects.toMatchObject({ code: "binary_untrusted" });

    const writableAncestor = join(bubbleHome, "world-writable-bin");
    await mkdir(writableAncestor, { recursive: true });
    await chmod(writableAncestor, 0o777);
    await expect(verifyGrokBinaryAncestors(
      join(writableAncestor, "grok"),
      process.getuid?.(),
    )).rejects.toMatchObject({ code: "binary_untrusted" });
    await expect(verifyGrokBinaryAncestors(fixture, process.getuid?.())).resolves.toBeUndefined();

    const writable = join(bubbleHome, "grok-world-writable");
    await copyFile(fixture, writable);
    await chmod(writable, 0o777);
    await expect(verifyGrokBinary({
      binaryPath: writable,
      expectedSha256: await sha256File(writable),
      platform: "darwin",
      arch: "arm64",
      uid: process.getuid?.(),
      readVersion: async () => "grok 0.2.93 (fake)",
    })).rejects.toMatchObject({ code: "binary_untrusted" });
  });

  it("fails closed when inspect discovers compatibility or project configuration", async () => {
    const runtime = manager();
    expect((await runtime.inspect()).state).toBe("signed_out");
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "unsafe-inspect"), "1", { mode: 0o600 });
    const status = await runtime.inspect();
    expect(status.state).toBe("unavailable");
    expect(status.message).toContain("hooks must be empty");
  });

  it("disables workspace project skills before starting the sidecar", async () => {
    const runtime = manager();
    await runtime.login();
    const profile = getGrokProfile(bubbleHome);
    const skillPaths = [
      { name: "my-skill", path: join(workspace, ".grok", "skills", "my-skill", "SKILL.md") },
      { name: "hyperframes", path: join(workspace, ".agents", "skills", "hyperframes", "SKILL.md") },
    ];
    for (const skill of skillPaths) {
      await mkdir(join(skill.path, ".."), { recursive: true });
      await writeFile(skill.path, "# fake skill\n", { mode: 0o600 });
    }
    await writeFile(join(profile.grokHome, "project-skills.json"), JSON.stringify(skillPaths), { mode: 0o600 });

    await expect(runtime.newSession()).resolves.toMatchObject({ provider: "grok" });

    const config = await readFile(profile.configPath, "utf8");
    expect(config).toMatch(/^disabled = \[.*"hyperframes", .*"my-skill".*\]$/m);
    expect(config).toContain('"code-review"');
    const requirements = await readFile(profile.requirementsPath, "utf8");
    expect(requirements).toContain('"my-skill"');
    const inspects = (await readCalls()).filter(
      (call) => call.command === "inspect" && call.args.includes(workspace),
    );
    expect(inspects.length).toBe(2);
  });

  it("fails closed when a workspace skill is not a plain project discovery", async () => {
    for (const skill of [
      { name: "user-skill", path: join(workspace, ".grok", "skills", "user-skill", "SKILL.md"), sourceType: "user" },
      { name: "outside", path: "/somewhere/else/skills/outside/SKILL.md", anywhere: true },
      { name: 'evil"name', path: join(workspace, ".grok", "skills", "evil", "SKILL.md") },
    ]) {
      const runtime = manager();
      await runtime.login();
      const profile = getGrokProfile(bubbleHome);
      const marker = join(profile.grokHome, "project-skills.json");
      await writeFile(marker, JSON.stringify([skill]), { mode: 0o600 });
      await expect(runtime.newSession()).rejects.toMatchObject({ code: "preflight_failed" });
      await rm(marker, { force: true });
      await runtime.dispose();
    }
  });

  it("accepts disabled compat-scanner MCP discoveries but rejects loadable ones", async () => {
    const runtime = manager();
    await runtime.login();
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "compat-mcp"), "1", { mode: 0o600 });
    await expect(runtime.newSession()).resolves.toMatchObject({ provider: "grok" });
    await runtime.dispose();

    await writeFile(join(profile.grokHome, "rogue-mcp"), "1", { mode: 0o600 });
    const second = manager();
    await expect(second.newSession()).rejects.toMatchObject({ code: "preflight_failed" });
  });

  it("kills the session when a skill-backed command is advertised mid-turn", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    await expect(collect(runtime.run("__skill_command__", { sessionId: session.id, generation: 1 })))
      .rejects.toMatchObject({ code: "policy_violation" });
    const calls = await readCalls();
    expect(calls.some((call) => call.acp === "session/cancel")).toBe(true);
  });

  it("does not import permissive workspace Claude permission settings", async () => {
    const claudeDir = join(workspace, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Bash(*)", "Edit(*)"] },
    }), { mode: 0o600 });

    const runtime = manager();
    expect((await runtime.inspect()).state).toBe("signed_out");
    const calls = await readCalls();
    expect(calls.find((call) => call.command === "inspect")?.envKeys)
      .toContain("_GROK_CLAUDE_MARKER_OVERRIDE");
  });

  it.each(["unsafe-permission-source", "unsafe-permission-object-source"])(
    "fails closed if Grok reports a workspace Claude permission source: %s",
    async (marker) => {
    const runtime = manager();
    expect((await runtime.inspect()).state).toBe("signed_out");
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, marker), "1", { mode: 0o600 });
    const status = await runtime.inspect();
    expect(status.state).toBe("unavailable");
    expect(status.message).toContain("permission source outside Bubble's isolated profile");
    expect((await readCalls()).some((call) => call.command === "agent-stdio")).toBe(false);
    },
  );

  it("fails closed when inspect output exceeds the bounded JSON capture", async () => {
    const runtime = manager();
    expect((await runtime.inspect()).state).toBe("signed_out");
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, "oversized-inspect"), "1", { mode: 0o600 });
    const status = await runtime.inspect();
    expect(status.state).toBe("unavailable");
    expect(status.message).toContain("exceeded the safe capture limit");
  });

  it("uses the isolated profile for login and removes credentials and runtime data on logout", async () => {
    const runtime = manager();
    await runtime.login();
    expect((await runtime.inspect()).state).toBe("ready");
    const profile = getGrokProfile(bubbleHome);
    expect((await stat(join(profile.grokHome, "auth.json"))).isFile()).toBe(true);

    await runtime.logout();
    expect((await runtime.inspect()).state).toBe("signed_out");
    await expect(stat(join(profile.grokHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const calls = await readCalls();
    expect(calls.find((call) => call.command === "login")?.args).toContain("--oauth");
    expect(calls.some((call) => call.command === "logout")).toBe(true);
  });

  it("opens only the strict xAI authorize URL and never surfaces raw login stdout", async () => {
    const opener = vi.fn(async (_url: string, _signal: AbortSignal) => undefined);
    const onBrowserOpened = vi.fn();
    const runtime = manager({ oauthOpener: opener });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runtime.login(undefined, onBrowserOpened);
    const logged = [...consoleError.mock.calls, ...consoleLog.mock.calls]
      .flat()
      .map((value) => String(value))
      .join("\n");
    consoleError.mockRestore();
    consoleLog.mockRestore();

    expect(opener).toHaveBeenCalledTimes(1);
    expect(onBrowserOpened).toHaveBeenCalledTimes(1);
    expect(opener.mock.calls[0]?.[0]).toBe(
      "https://auth.x.ai/oauth2/authorize?client_id=fake-client&state=oauth-state-secret",
    );
    expect(logged).not.toContain("oauth-state-secret");
    expect(logged).not.toContain("stdout-token-secret");

    await runtime.dispose();
    const unsafe = manager({ oauthOpener: opener });
    await unsafe.inspect();
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, "unsafe-login-url"), "1", { mode: 0o600 });
    await unsafe.login();
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it("accepts the strict authorize URL from stderr and redacts its entire query", async () => {
    const opener = vi.fn(async (_url: string, _signal: AbortSignal) => undefined);
    const runtime = manager({ oauthOpener: opener });
    await runtime.inspect();
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, "login-url-stderr"), "1", { mode: 0o600 });
    await runtime.login();
    expect(opener).toHaveBeenCalledWith(
      "https://auth.x.ai/oauth2/authorize?client_id=fake-client&state=stderr-oauth-state-secret",
      expect.any(AbortSignal),
    );
    const sanitized = sanitizeGrokDiagnostic(
      "open https://auth.x.ai/oauth2/authorize?client_id=secret-client&state=secret-state&code_challenge=secret-challenge",
    );
    expect(sanitized).toBe("open https://auth.x.ai/oauth2/authorize?[redacted]");
    expect(sanitized).not.toContain("secret-state");
    expect(sanitized).not.toContain("secret-challenge");
  });

  it("dispose aborts and waits for browser login, then removes every transient auth artifact and lock", async () => {
    const opener = vi.fn(async (_url: string, _signal: AbortSignal) => undefined);
    const runtime = manager({ oauthOpener: opener });
    await runtime.inspect();
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "slow-login"), "1", { mode: 0o600 });

    const loginResult = runtime.login().then(
      () => undefined,
      (error) => error,
    );
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    await runtime.dispose();
    expect(await loginResult).toMatchObject({ code: "cancelled" });
    const loginPid = (await readCalls()).find((call) => call.command === "login")?.pid as number;
    let processProbe: NodeJS.ErrnoException | undefined;
    try {
      process.kill(loginPid, 0);
    } catch (error) {
      processProbe = error as NodeJS.ErrnoException;
    }
    expect(processProbe?.code).toBe("ESRCH");

    for (const path of [
      profile.lockPath,
      join(profile.grokHome, "auth.json.lock"),
      join(profile.grokHome, "logs"),
      join(profile.grokHome, "docs"),
      join(profile.tmp, "oauth-browser.log"),
    ]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("honors a caller AbortSignal for login and releases the profile lock", async () => {
    const opener = vi.fn(async (_url: string, _signal: AbortSignal) => undefined);
    const runtime = manager({ oauthOpener: opener });
    await runtime.inspect();
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "slow-login"), "1", { mode: 0o600 });
    const controller = new AbortController();
    const loginResult = runtime.login(controller.signal).then(
      () => undefined,
      (error) => error,
    );
    await vi.waitFor(() => expect(opener).toHaveBeenCalledTimes(1));
    controller.abort(new Error("test cancellation"));
    expect(await loginResult).toMatchObject({ code: "cancelled" });
    await expect(stat(profile.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans transient auth artifacts when browser login fails", async () => {
    const runtime = manager();
    await runtime.inspect();
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "fail-login"), "1", { mode: 0o600 });
    let failure: unknown;
    try {
      await runtime.login();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "not_authenticated" });
    expect((failure as GrokRuntimeError).diagnostic).not.toContain("login-secret");
    await expect(stat(join(profile.grokHome, "auth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(profile.grokHome, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes isolated credentials even when the pinned CLI is no longer available", async () => {
    const runtime = manager();
    await runtime.login();
    await runtime.dispose();
    const profile = getGrokProfile(bubbleHome);
    expect((await stat(join(profile.grokHome, "auth.json"))).isFile()).toBe(true);
    const missing = manager({ binaryPath: join(bubbleHome, "missing-after-login") });
    await expect(missing.logout()).resolves.toBeUndefined();
    await expect(stat(join(profile.grokHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes with cached_token and streams only text and thought events", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const events = await collect(runtime.run("hello", { sessionId: session.id, generation: 7 }));
    expect(events).toEqual([
      { type: "turn_start" },
      { type: "reasoning_delta", content: "thinking" },
      { type: "text_delta", content: "hello" },
      { type: "turn_end" },
    ]);

    const calls = await readCalls();
    expect(calls.find((call) => call.acp === "authenticate")?.params).toEqual({ methodId: "cached_token" });
    const created = calls.find((call) => call.acp === "session/new")?.params;
    expect(created).toMatchObject({ cwd: workspace, mcpServers: [], additionalDirectories: [] });
    const promptCall = calls.find((call) => call.acp === "session/prompt");
    expect(promptCall?.text).toBe("hello");
    expect(promptCall?.meta).toEqual({ bubbleGeneration: 7 });
    const acpArgs = calls.find((call) => call.command === "agent-stdio")?.args as string[];
    expect(acpArgs).toEqual(GROK_ACP_ARGS(workspace));
    expect(acpArgs[acpArgs.indexOf("--tools") + 1]).toBe("Read,Edit,Grep,Bash");
    expect(acpArgs).not.toContain("--deny");
    expect(acpArgs[acpArgs.indexOf("--permission-mode") + 1]).toBe("default");
    expect(acpArgs[acpArgs.indexOf("--sandbox") + 1]).toBe("strict");
    expect(acpArgs).toEqual(expect.arrayContaining([
      "--no-auto-update",
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--disable-web-search",
      "agent",
      "--no-leader",
      "stdio",
    ]));
  });

  it("lists subscription models and atomically switches model and reasoning on the same session", async () => {
    const runtime = manager();
    await runtime.login();
    expect(await runtime.listModels()).toEqual([
      {
        id: "grok-4.5",
        name: "grok-4.5",
        reasoningLevels: ["low", "medium", "high"],
        defaultReasoningLevel: "high",
      },
      {
        id: "grok-composer-2.5-fast",
        name: "grok-composer-2.5-fast",
        reasoningLevels: ["off"],
        defaultReasoningLevel: "off",
      },
    ]);
    const session = await runtime.newSession();
    await expect(runtime.setModel("grok-4.5", "low")).resolves.toEqual({
      modelId: "grok-4.5",
      reasoningEffort: "low",
    });
    await expect(runtime.setModel("grok-composer-2.5-fast", "off")).resolves.toEqual({
      modelId: "grok-composer-2.5-fast",
      reasoningEffort: "off",
    });
    await expect(runtime.setModel("grok-composer-2.5-fast", "high")).rejects.toMatchObject({ code: "protocol_error" });

    const calls = await readCalls();
    const sidecars = calls.filter((call) => call.command === "agent-stdio");
    expect(sidecars.at(-1)?.args).toEqual(GROK_ACP_ARGS(workspace, "grok-composer-2.5-fast", "off"));
    expect(calls.filter((call) => call.acp === "session/load").at(-1)?.params.sessionId).toBe(session.id);
    expect(calls.filter((call) => call.acp === "session/set_model").map((call) => call.params.modelId))
      .toEqual(["grok-4.5", "grok-composer-2.5-fast"]);
  });

  it("hydrates persisted metadata before the first prompt after manager restart", async () => {
    const first = manager();
    await first.login();
    const session = await first.newSession();
    await first.dispose();

    const resumed = manager();
    await expect(resumed.hydrateSession(session.id, "grok-composer-2.5-fast", "off"))
      .resolves.toMatchObject({
        id: session.id,
        modelId: "grok-composer-2.5-fast",
        reasoningEffort: "off",
      });
    await expect(collect(resumed.run("hello", { sessionId: session.id })))
      .resolves.toContainEqual({ type: "text_delta", content: "hello" });

    const calls = await readCalls();
    const resumedCalls = calls.filter((call) => call.acp === "session/load"
      || call.acp === "session/set_model"
      || call.acp === "session/prompt");
    expect(resumedCalls.slice(-4).map((call) => call.acp)).toEqual([
      "session/load",
      "session/set_model",
      "session/load",
      "session/prompt",
    ]);
    expect(resumedCalls.at(-1)?.sessionId).toBe(session.id);
  });

  it("bridges Grok allow-once permission requests through Bubble approvals", async () => {
    const request = vi.fn(async () => ({ action: "approve" as const }));
    const runtime = manager({
      approvalController: { request, checkRules: vi.fn(() => ({ decision: "ask" as const })) },
    });
    await runtime.login();
    const session = await runtime.newSession();
    await expect(collect(runtime.run("__permission__", { sessionId: session.id }))).resolves.toContainEqual({ type: "turn_end" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      type: "external_tool",
      toolCallId: "tool-1",
      title: "forbidden",
    }));
    const calls = await readCalls();
    expect(calls.find((call) => call.acp === "permission-response")?.result).toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("keeps permissive workspace Claude settings behind Bubble rejection", async () => {
    const claudeDir = join(workspace, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Bash(*)", "Edit(*)"] },
    }), { mode: 0o600 });
    const request = vi.fn(async () => ({ action: "reject" as const }));
    const runtime = manager({
      approvalController: { request, checkRules: vi.fn(() => ({ decision: "ask" as const })) },
    });
    await runtime.login();
    const session = await runtime.newSession();
    await expect(collect(runtime.run("__permission__", { sessionId: session.id })))
      .resolves.toContainEqual({ type: "turn_end" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      type: "external_tool",
      toolCallId: "tool-1",
    }));
    const response = (await readCalls()).find((call) => call.acp === "permission-response")?.result;
    expect(response).toEqual({ outcome: { outcome: "cancelled" } });
    expect(response).not.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it.each([
    ["missing-load-capability", "protocol_error"],
    ["missing-cached-auth", "not_authenticated"],
  ])("fails closed when initialize omits required runtime contract: %s", async (marker, code) => {
    const runtime = manager();
    await runtime.login();
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, marker), "1", { mode: 0o600 });
    await expect(runtime.newSession()).rejects.toMatchObject({ code });
  });

  it("ignores only available-command metadata during initialize, load, and a prompt", async () => {
    const runtime = manager();
    await runtime.login();
    const profile = getGrokProfile(bubbleHome);
    await writeFile(join(profile.grokHome, "initialize-available"), "1", { mode: 0o600 });
    await expect(runtime.newSession()).resolves.toMatchObject({ provider: "grok" });
    await expect(runtime.loadSession("__load_available__")).resolves.toMatchObject({
      id: "__load_available__",
      provider: "grok",
    });
    const events = await collect(runtime.run("__available_commands__", { sessionId: "__load_available__" }));
    expect(events).toContainEqual({ type: "text_delta", content: "safe-after-metadata" });
    expect(events.at(-1)).toEqual({ type: "turn_end" });
  });

  it("consumes transcript replay during load without exposing it as a new turn", async () => {
    const runtime = manager();
    await runtime.login();
    await expect(runtime.loadSession("__load_replay__")).resolves.toMatchObject({
      id: "__load_replay__",
      provider: "grok",
    });
    const events = await collect(runtime.run("hello", { sessionId: "__load_replay__" }));
    expect(events).toContainEqual({ type: "text_delta", content: "hello" });
    expect(JSON.stringify(events)).not.toContain("replayed-user-secret");
    expect(JSON.stringify(events)).not.toContain("replayed-assistant-secret");
  });

  it.each(["initialize-plan"])(
    "fails closed on dangerous ACP activity without an active turn: %s",
    async (marker) => {
      const runtime = manager();
      await runtime.login();
      await writeFile(join(getGrokProfile(bubbleHome).grokHome, marker), "1", { mode: 0o600 });
      await expect(runtime.newSession()).rejects.toMatchObject({ code: "policy_violation" });
    },
  );

  it("rejects an initialization-time permission request without failing the runtime", async () => {
    const runtime = manager();
    await runtime.login();
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, "initialize-permission"), "1", { mode: 0o600 });
    await expect(runtime.newSession()).resolves.toMatchObject({ provider: "grok" });
    const calls = await readCalls();
    expect(calls.find((call) => call.acp === "initialize-permission-response")?.result)
      .toEqual({ outcome: { outcome: "cancelled" } });
  });

  it.each(["__load_plan__", "__load_tool__"])(
    "consumes inert historical ACP records while loading a session: %s",
    async (sessionId) => {
      const runtime = manager();
      await runtime.login();
      await runtime.newSession();
      await expect(runtime.loadSession(sessionId)).resolves.toMatchObject({ id: sessionId });
      await expect(collect(runtime.run("hello", { sessionId }))).resolves.toContainEqual({
        type: "text_delta",
        content: "hello",
      });
    },
  );

  it("filters updates by session and generation", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const events = await collect(runtime.run("__generation__", { sessionId: session.id, generation: 2 }));
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", content: "fresh" },
    ]);
  });

  it("isolates concurrent ACP session IDs", async () => {
    const runtime = manager();
    await runtime.login();
    const first = await runtime.newSession();
    const second = await runtime.newSession();
    expect(first.id).not.toBe(second.id);
    const events = await collect(runtime.run("__session_isolation__", { sessionId: first.id }));
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", content: "active-session" },
    ]);
  });

  it("drops a late update from the prior generation on the same session", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    await collect(runtime.run("__late_start__", { sessionId: session.id, generation: 11 }));
    const events = await collect(runtime.run("__late_receive__", { sessionId: session.id, generation: 12 }));
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", content: "current" },
    ]);
    const calls = await readCalls();
    expect(calls.filter((call) => call.command === "agent-stdio")).toHaveLength(2);
    expect(calls.some((call) => call.acp === "session/load" && call.params.sessionId === session.id)).toBe(true);
  });

  it("does not fall back to a fresh session when required turn-to-turn load fails", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    await collect(runtime.run("hello", { sessionId: session.id }));
    await writeFile(join(getGrokProfile(bubbleHome).grokHome, "fail-load"), "1", { mode: 0o600 });
    await expect(collect(runtime.run("must-not-fallback", { sessionId: session.id })))
      .rejects.toMatchObject({ code: "protocol_error" });
    const calls = await readCalls();
    expect(calls.filter((call) => call.acp === "session/new")).toHaveLength(1);
    expect(calls.some((call) => call.acp === "session/load" && call.params.sessionId === session.id)).toBe(true);
    expect(calls.some((call) => call.acp === "session/prompt" && call.text === "must-not-fallback")).toBe(false);
  });

  it("cancels an in-flight turn and remains reusable", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const iterator = runtime.run("__cancel_wait__", { sessionId: session.id })[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "turn_start" } });
    await runtime.cancel(session.id);
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
    expect((await collect(runtime.run("hello", { sessionId: session.id }))).some((event) => event.type === "text_delta")).toBe(true);
  });

  it("drops queued and late deltas after cancel and maps provider cancellation to interruption", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const iterator = runtime.run("__cancel_late_delta__", { sessionId: session.id })[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: "turn_start" } });
    await runtime.cancel(session.id);
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });

    await expect(collect(runtime.run("__provider_cancelled__", { sessionId: session.id })))
      .rejects.toMatchObject({ code: "cancelled" });
  });

  it.each(["__unknown__", "__fs_request__"])("terminates on forbidden ACP activity: %s", async (prompt) => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    await expect(collect(runtime.run(prompt, { sessionId: session.id }))).rejects.toMatchObject({
      code: "policy_violation",
    });
    const calls = await readCalls();
    expect(calls.some((call) => call.acp === "session/cancel" && call.sessionId === session.id)).toBe(true);
  });

  it("rejects a Grok permission request when no interactive approval controller is attached", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    await expect(collect(runtime.run("__permission__", { sessionId: session.id }))).resolves.toContainEqual({ type: "turn_end" });
    const calls = await readCalls();
    expect(calls.find((call) => call.acp === "permission-response")?.result)
      .toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("streams Grok workspace tool lifecycle events", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const events = await collect(runtime.run("__tool__", { sessionId: session.id }));
    expect(events).toContainEqual({
      type: "tool_start",
      id: "tool-1",
      name: "forbidden",
      args: { path: "package.json" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", id: "tool-1" }));
  });

  it("clears incomplete tool state before a later turn reuses the same tool ID", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const incomplete = await collect(runtime.run("__tool_incomplete__", { sessionId: session.id }));
    expect(incomplete).toContainEqual(expect.objectContaining({ type: "tool_start", id: "tool-1" }));
    const next = await collect(runtime.run("__tool__", { sessionId: session.id }));
    expect(next).toContainEqual(expect.objectContaining({ type: "tool_start", id: "tool-1" }));
  });

  it.each(["__oversized_acp__", "__malformed_acp__", "__non_jsonrpc__"])("fails closed on unsafe ACP framing: %s", async (prompt) => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failure: unknown;
    try {
      await collect(runtime.run(prompt, { sessionId: session.id }));
    } catch (error) {
      failure = error;
    }
    const logged = consoleError.mock.calls.flat().map((value) => String(value)).join("\n");
    consoleError.mockRestore();
    expect(failure).toBeInstanceOf(GrokRuntimeError);
    expect(failure).toMatchObject({ code: "protocol_error" });
    expect((failure as GrokRuntimeError).message).not.toContain("raw-");
    expect((failure as GrokRuntimeError).diagnostic ?? "").not.toContain("raw-");
    expect(logged).not.toContain("raw-oversized-secret");
    expect(logged).not.toContain("raw-malformed-secret");
    expect(logged).not.toContain("raw-nonrpc-secret");
  });

  it("drops unsolicited ACP responses without letting the SDK log their IDs", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = await collect(runtime.run("__unsolicited_response__", { sessionId: session.id }));
    const logged = consoleError.mock.calls.flat().map((value) => String(value)).join("\n");
    consoleError.mockRestore();
    expect(events).toContainEqual({ type: "text_delta", content: "safe" });
    expect(logged).not.toContain("raw-unsolicited-secret");
  });

  it("redacts bounded stderr when the ACP process crashes", async () => {
    const runtime = manager();
    await runtime.login();
    const session = await runtime.newSession();
    let failure: unknown;
    try {
      await collect(runtime.run("__crash__", { sessionId: session.id }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GrokRuntimeError);
    expect(failure).toMatchObject({ code: "process_crashed" });
    expect((failure as GrokRuntimeError).diagnostic).not.toContain("super-secret-token");
    expect((failure as GrokRuntimeError).diagnostic).not.toContain("xai-secret");
    expect((failure as GrokRuntimeError).diagnostic).not.toContain("refresh-secret");
    expect((failure as GrokRuntimeError).diagnostic).not.toContain("url-secret");
  });

  it("reconnects the same manager after dispose and can load or create another session", async () => {
    const runtime = manager();
    await runtime.login();
    await runtime.newSession();
    expect((await stat(join(getGrokProfile(bubbleHome).grokHome, "skills", "help", "SKILL.md"))).isFile()).toBe(true);
    await runtime.dispose();
    await expect(stat(join(getGrokProfile(bubbleHome).grokHome, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await runtime.loadSession("saved-session");
    expect(loaded.id).toBe("saved-session");
    await runtime.dispose();
    const created = await runtime.newSession();
    expect(created.id).toMatch(/^fake-session-/);
    const calls = await readCalls();
    expect(calls.some((call) => call.acp === "session/load" && call.params.sessionId === "saved-session")).toBe(true);
    expect(calls.filter((call) => call.command === "agent-stdio")).toHaveLength(3);
  });

  it("holds an exclusive profile lock while the sidecar is connected", async () => {
    const first = manager();
    await first.login();
    await first.newSession();
    const profile = getGrokProfile(bubbleHome);
    const activeLog = join(profile.grokHome, "logs", "active-owner.log");
    await mkdir(join(profile.grokHome, "logs"), { recursive: true });
    await writeFile(activeLog, "owned by first sidecar", { mode: 0o600 });
    const activeConfig = `${await readFile(profile.configPath, "utf8")}\n# active-owner-sentinel\n`;
    await writeFile(profile.configPath, activeConfig, { mode: 0o600 });
    const blockedVersionRead = vi.fn(async () => "grok 0.2.93");
    const second = manager({ readVersion: blockedVersionRead });
    const blocked = await second.inspect();
    expect(blocked.state).toBe("unavailable");
    expect(blocked.message).toContain("already in use");
    expect(blockedVersionRead).not.toHaveBeenCalled();
    await expect(readFile(activeLog, "utf8")).resolves.toBe("owned by first sidecar");
    await expect(readFile(profile.configPath, "utf8")).resolves.toBe(activeConfig);
    await first.dispose();
    await expect(stat(activeLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await second.inspect()).state).toBe("ready");
  });

  it("recovers a private lock left by a dead owner but rejects invalid lock data", async () => {
    const runtime = manager();
    expect((await runtime.inspect()).state).toBe("signed_out");
    const profile = getGrokProfile(bubbleHome);
    await writeFile(profile.lockPath, "2147483646\n", { mode: 0o600 });
    expect((await runtime.inspect()).state).toBe("signed_out");
    await expect(stat(profile.lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(profile.lockPath, "not-a-pid\n", { mode: 0o600 });
    const unsafe = await runtime.inspect();
    expect(unsafe.state).toBe("unavailable");
    expect(unsafe.message).toContain("lock is invalid");
  });
});
