import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import { BashAllowlist } from "../approval/session-cache.js";
import { isProtectedWorkspacePath } from "../approval/protected-paths.js";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types.js";
import { buildRuleSet, checkPermission } from "../permissions/rule.js";
import { analyzeShellCommand } from "../permissions/shell-command.js";
import { gateMcpTools } from "../mcp/manager.js";
import { isSensitivePath } from "../tools/sensitive-paths.js";
import { isWithinWorkspace } from "../tools/file-state.js";
import type { PermissionMode, ToolRegistryEntry } from "../types.js";

const CWD = "/tmp/bubble-hardening";

function controller(
  mode: PermissionMode,
  handler: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  extra: { allow?: string[]; deny?: string[]; grants?: Set<string>; bash?: BashAllowlist } = {},
) {
  return new PermissionAwareApprovalController({
    getMode: () => mode,
    handlerRef: { current: handler },
    cwd: CWD,
    bashAllowlist: extra.bash ?? new BashAllowlist(),
    sessionGrants: extra.grants ?? new Set(),
    getRuleSet: () => buildRuleSet(extra.allow ?? [], extra.deny ?? []),
  });
}

describe("analyzeShellCommand", () => {
  it("splits control operators outside quotes and strips leading keywords", () => {
    expect(analyzeShellCommand("git status && npm test; ls | wc -l").segments)
      .toEqual(["git status", "npm test", "ls", "wc -l"]);
    expect(analyzeShellCommand("if true; then rm -rf x; fi").segments).toEqual(["true", "rm -rf x"]);
    expect(analyzeShellCommand("echo 'a && b' \"c; d\"").segments).toEqual(["echo 'a && b' \"c; d\""]);
    expect(analyzeShellCommand("(rm -rf x)").segments).toEqual(["rm -rf x"]);
  });

  it("flags constructs an allow rule cannot vouch for", () => {
    expect(analyzeShellCommand("git status").opaque).toBe(false);
    expect(analyzeShellCommand("git status 2>&1").opaque).toBe(false);
    expect(analyzeShellCommand("git status > /dev/null 2>/dev/null").opaque).toBe(false);
    for (const command of [
      "echo $(rm -rf x)",
      "echo \"$(rm -rf x)\"",
      "echo `rm -rf x`",
      "echo hi > ~/.bashrc",
      "cat < secrets.txt",
      "cat <<EOF\nhi\nEOF",
      "diff <(ls a) <(ls b)",
      "for f in *; do rm $f; done",
      "echo 'unterminated",
    ]) {
      expect(analyzeShellCommand(command).opaque, command).toBe(true);
    }
    expect(analyzeShellCommand("echo $(rm -rf x)").segments).toContain("rm -rf x");
  });
});

describe("compound-aware bash matching", () => {
  it("allow rules cover a compound command only when every part matches", () => {
    const rules = buildRuleSet(["Bash(git status:*)", "Bash(npm test)"], []);
    const check = (command: string) => checkPermission(rules, { tool: "Bash", command }).decision;
    expect(check("git status -s")).toBe("allow");
    expect(check("git status && npm test")).toBe("allow");
    expect(check("git status && rm -rf ~")).toBe("ask");
    expect(check("git status `rm -rf ~`")).toBe("ask");
    expect(checkPermission(buildRuleSet(["Bash(:*)"], []), { tool: "Bash", command: "echo $(date)" }).decision)
      .toBe("allow");
  });

  it("deny rules fire on any part, through wrappers and substitutions", () => {
    const rules = buildRuleSet([], ["Bash(rm:*)"]);
    const check = (command: string) => checkPermission(rules, { tool: "Bash", command }).decision;
    for (const command of [
      "rm -rf x",
      "echo ok && rm -rf x",
      "echo ok; rm -rf x",
      "sudo rm -rf x",
      "FOO=1 rm -rf x",
      "env FOO=1 rm -rf x",
      "echo $(rm -rf x)",
      "if true; then rm -rf x; fi",
      "(rm -rf x)",
      "'rm' -rf x",
      "\\rm -rf x",
      "/bin/rm -rf x",
    ]) {
      expect(check(command), command).toBe("deny");
    }
    expect(check("echo rm")).toBe("ask");
  });

});

describe("protected workspace paths", () => {
  it("covers git internals and agent permission settings only", () => {
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.git/hooks/pre-commit`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.git/config`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/vendor/lib/.git/config`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.bubble/settings.json`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.bubble/settings.local.json`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.claude/settings.local.json`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/src/settings.json`)).toBe(false);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.gitignore`)).toBe(false);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.bubble/agents/reviewer.md`)).toBe(false);
  });

  it("is case-insensitive, as the default macOS filesystem is", () => {
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.GIT/config`)).toBe(true);
    expect(isProtectedWorkspacePath(CWD, `${CWD}/.Bubble/Settings.json`)).toBe(true);
  });

  it("default mode asks for protected files even when a broad allow rule matches", async () => {
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "reject" }));
    const gate = controller("default", handler, { allow: ["Write", "Edit"] });

    await expect(gate.request({ type: "write", path: `${CWD}/src/a.ts`, content: "", fileExists: false }))
      .resolves.toEqual({ action: "approve" });
    expect(handler).not.toHaveBeenCalled();

    await gate.request({ type: "write", path: `${CWD}/.bubble/settings.local.json`, content: "{}", fileExists: false });
    await gate.request({ type: "edit", path: `${CWD}/.git/config`, diff: "", fileExists: true });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([req]) => (req as { protectedPath?: boolean }).protectedPath)).toEqual([true, true]);
  });

  it("bypassPermissions still writes protected files without asking", async () => {
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "reject" }));
    await expect(controller("bypassPermissions", handler).request({
      type: "edit", path: `${CWD}/.git/config`, diff: "", fileExists: true,
    })).resolves.toEqual({ action: "approve" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("symlinks at the workspace boundary", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bubble-links-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a link inside the workspace cannot carry a write outside it", () => {
    const workspace = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "docs"));
    symlinkSync(join(outside, "created-later.txt"), join(workspace, "dangling"));
    expect(isWithinWorkspace(workspace, join(workspace, "src/a.ts"))).toBe(true);
    expect(isWithinWorkspace(workspace, join(workspace, "docs/new.txt"))).toBe(false);
    expect(isWithinWorkspace(workspace, join(workspace, "dangling"))).toBe(false);
    expect(isWithinWorkspace(workspace, join(workspace, "..weird-but-inside"))).toBe(true);
  });

  it("a link into .git keeps hooks protected", () => {
    const workspace = join(root, "repo");
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    symlinkSync(join(workspace, ".git", "hooks"), join(workspace, "hooks"));
    expect(isProtectedWorkspacePath(workspace, join(workspace, "hooks/pre-commit"))).toBe(true);
    expect(isProtectedWorkspacePath(workspace, join(workspace, "src/a.ts"))).toBe(false);
  });
});

describe("session grants", () => {
  it("remembers exactly the approved command when the user chose this session", async () => {
    const bash = new BashAllowlist();
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => (
      { action: "approve", remember: "session" }
    ));
    const gate = controller("default", handler, { bash });
    await gate.request({ type: "bash", command: "cd pkg && npm test | tail -30", cwd: CWD });
    expect(handler.mock.calls[0][0]).toMatchObject({ sessionGrant: "cd pkg && npm test | tail -30" });
    await gate.request({ type: "bash", command: "  cd pkg && npm test | tail -30 ", cwd: CWD });
    expect(handler).toHaveBeenCalledTimes(1);
    // Any variant — an extra command, other arguments — asks again.
    await gate.request({ type: "bash", command: "cd pkg && npm test | tail -30 && rm -rf ~", cwd: CWD });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not remember an approval given only once", async () => {
    const bash = new BashAllowlist();
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "approve" }));
    await controller("default", handler, { bash }).request({ type: "bash", command: "npm test", cwd: CWD });
    expect(bash.size()).toBe(0);
  });

  it("deny rules still win over a session grant", async () => {
    const bash = new BashAllowlist();
    bash.add("git push origin main");
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "approve" }));
    const decision = await controller("default", handler, { bash, deny: ["Bash(git push:*)"] })
      .request({ type: "bash", command: "git push origin main", cwd: CWD });
    expect(decision.action).toBe("reject");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("MCP tools", () => {
  const calls: unknown[] = [];
  const tool: ToolRegistryEntry = {
    name: "mcp__github__create_issue",
    description: "[MCP:github] create an issue",
    parameters: { type: "object", properties: {} },
    readOnly: false,
    effect: "unknown",
    async execute(args) {
      calls.push(args);
      return { content: "created" };
    },
  };
  beforeEach(() => { calls.length = 0; });

  it("asks before calling an MCP tool in default mode", async () => {
    const handler = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "reject", feedback: "no" }));
    const [gated] = gateMcpTools([tool], controller("default", handler));
    const result = await gated.execute({ title: "x" }, { cwd: CWD, toolCall: { id: "t1", name: tool.name } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: "external_tool", kind: "mcp", title: tool.name });
  });

  it("honors server-wide allow rules, session grants and bypass", async () => {
    const never = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "reject" }));
    await gateMcpTools([tool], controller("default", never, { allow: ["mcp__github"] }))[0].execute({}, { cwd: CWD });
    await gateMcpTools([tool], controller("bypassPermissions", never))[0].execute({}, { cwd: CWD });
    expect(never).not.toHaveBeenCalled();

    const grants = new Set<string>();
    const once = vi.fn(async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({ action: "approve", remember: "session" }));
    const [gated] = gateMcpTools([tool], controller("default", once, { grants }));
    await gated.execute({}, { cwd: CWD });
    await gated.execute({}, { cwd: CWD });
    expect(once).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(4);
  });
});

describe("sensitive credential paths", () => {
  let home: string;
  const originalHome = process.env.HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bubble-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("blocks private keys and credential stores but not public ssh files", () => {
    expect(isSensitivePath(join(home, ".ssh/id_ed25519"))).toBe(true);
    expect(isSensitivePath(join(home, ".ssh/keys/deploy"))).toBe(true);
    expect(isSensitivePath(join(home, ".ssh/id_ed25519.pub"))).toBe(false);
    expect(isSensitivePath(join(home, ".ssh/config"))).toBe(false);
    expect(isSensitivePath(join(home, ".ssh/known_hosts"))).toBe(false);
    expect(isSensitivePath(join(home, ".aws/credentials"))).toBe(true);
    expect(isSensitivePath(join(home, ".aws/config"))).toBe(false);
    expect(isSensitivePath(join(home, ".config/gcloud/application_default_credentials.json"))).toBe(true);
    expect(isSensitivePath(join(home, ".gnupg/private-keys-v1.d/x.key"))).toBe(true);
    expect(isSensitivePath(join(home, "project/.env"))).toBe(false);
    // Case variants open the same file on the default macOS filesystem.
    expect(isSensitivePath(join(home, ".AWS/Credentials"))).toBe(true);
    expect(isSensitivePath(join(home, ".SSH/id_ed25519"))).toBe(true);
    expect(isSensitivePath(join(home, ".SSH/Config"))).toBe(false);
  });

  it("follows symlinks so a workspace link cannot reach a credential file", () => {
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(join(home, ".aws/credentials"), "[default]\n");
    const workspace = join(home, "project");
    mkdirSync(workspace);
    symlinkSync(join(home, ".aws/credentials"), join(workspace, "creds.txt"));
    expect(isSensitivePath(join(workspace, "creds.txt"))).toBe(true);
  });
});
