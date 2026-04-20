import { describe, expect, it } from "vitest";
import { BashAllowlist, inferBashPrefix } from "../approval/session-cache.js";
import { PermissionAwareApprovalController } from "../approval/controller.js";
import type { ApprovalRequest } from "../approval/types.js";

describe("BashAllowlist", () => {
  it("matches exact and whitespace-separated command extensions", () => {
    const a = new BashAllowlist();
    a.add("git status");
    expect(a.matches("git status")).toBe(true);
    expect(a.matches("git status -s")).toBe(true);
    expect(a.matches("git status --porcelain")).toBe(true);
    expect(a.matches("git push")).toBe(false);
    expect(a.matches("git statuss")).toBe(false);
    expect(a.matches("GIT STATUS")).toBe(false); // case-sensitive
  });

  it("ignores trailing :* sugar when storing", () => {
    const a = new BashAllowlist();
    a.add("npm run:*");
    expect(a.list()).toEqual(["npm run"]);
    expect(a.matches("npm run test")).toBe(true);
  });

  it("trims whitespace and deduplicates", () => {
    const a = new BashAllowlist();
    a.add("  git  ");
    a.add("git");
    expect(a.size()).toBe(1);
    expect(a.list()).toEqual(["git"]);
  });

  it("ignores empty and all-whitespace entries", () => {
    const a = new BashAllowlist();
    a.add("");
    a.add("   ");
    a.add(":*");
    expect(a.size()).toBe(0);
  });

  it("supports remove and clear", () => {
    const a = new BashAllowlist();
    a.add("npm test");
    a.add("git diff");
    expect(a.remove("npm test")).toBe(true);
    expect(a.remove("does-not-exist")).toBe(false);
    expect(a.list()).toEqual(["git diff"]);
    a.clear();
    expect(a.list()).toEqual([]);
  });
});

describe("inferBashPrefix", () => {
  it("uses two-token prefix when the second token looks like a subcommand", () => {
    expect(inferBashPrefix("git status -s")).toBe("git status");
    expect(inferBashPrefix("npm run test")).toBe("npm run");
    expect(inferBashPrefix("npm test")).toBe("npm test");
  });

  it("falls back to one token when the second starts with a flag or path", () => {
    expect(inferBashPrefix("rm -rf /tmp/x")).toBe("rm");
    expect(inferBashPrefix("node ./main.js")).toBe("node");
  });

  it("handles single-token and empty commands", () => {
    expect(inferBashPrefix("ls")).toBe("ls");
    expect(inferBashPrefix("   ")).toBe("");
    expect(inferBashPrefix("")).toBe("");
  });
});

describe("PermissionAwareApprovalController + BashAllowlist integration", () => {
  it("lets previously-allowlisted bash commands through without the UI", async () => {
    const bashAllowlist = new BashAllowlist();
    bashAllowlist.add("git status");
    let uiCalls = 0;
    const controller = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {
        current: async () => {
          uiCalls += 1;
          return { action: "approve" };
        },
      },
      bashAllowlist,
      cwd: "/tmp/bubble-test",
    });

    const req: ApprovalRequest = { type: "bash", command: "git status -s", cwd: "/tmp" };
    expect((await controller.request(req)).action).toBe("approve");
    expect(uiCalls).toBe(0);
  });

  it("still asks the UI for bash commands outside the allowlist", async () => {
    const bashAllowlist = new BashAllowlist();
    bashAllowlist.add("git status");
    let uiCalls = 0;
    const controller = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {
        current: async () => {
          uiCalls += 1;
          return { action: "reject", feedback: "no" };
        },
      },
      bashAllowlist,
      cwd: "/tmp/bubble-test",
    });

    const req: ApprovalRequest = { type: "bash", command: "git push", cwd: "/tmp" };
    const decision = await controller.request(req);
    expect(decision.action).toBe("reject");
    expect(uiCalls).toBe(1);
  });

  it("does not consult the allowlist for edit or write requests", async () => {
    const bashAllowlist = new BashAllowlist();
    bashAllowlist.add("whatever");
    let uiCalls = 0;
    const controller = new PermissionAwareApprovalController({
      getMode: () => "default",
      handlerRef: {
        current: async () => {
          uiCalls += 1;
          return { action: "approve" };
        },
      },
      bashAllowlist,
      cwd: "/tmp/bubble-test",
    });

    await controller.request({ type: "edit", path: "/tmp/x.ts", diff: "-", fileExists: true });
    await controller.request({ type: "write", path: "/tmp/y.ts", content: "hi", fileExists: false });
    expect(uiCalls).toBe(2);
  });
});
