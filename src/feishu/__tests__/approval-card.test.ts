import { describe, expect, it } from "vitest";
import { formatApprovalRequest } from "../agent-host/approval-card.js";

describe("formatApprovalRequest", () => {
  it("formats bash with cwd and code-fenced command", () => {
    const out = formatApprovalRequest({ type: "bash", command: "ls -la", cwd: "/tmp/x" });
    expect(out.title).toBe("执行命令");
    expect(out.body).toContain("ls -la");
    expect(out.body).toContain("/tmp/x");
    expect(out.body).toContain("```bash");
  });

  it("formats write with diff when present", () => {
    const out = formatApprovalRequest({
      type: "write",
      path: "/tmp/x",
      content: "hello",
      diff: "@@ -1 +1 @@\n-old\n+new",
      fileExists: true,
    });
    expect(out.title).toBe("覆盖文件");
    expect(out.body).toContain("@@ -1 +1 @@");
  });

  it("formats edit with diff", () => {
    const out = formatApprovalRequest({
      type: "edit",
      path: "/tmp/x",
      diff: "--- a\n+++ b\n",
      fileExists: true,
    });
    expect(out.title).toBe("编辑文件");
    expect(out.body).toContain("--- a");
  });

  it("truncates absurdly long commands", () => {
    const out = formatApprovalRequest({
      type: "bash",
      command: "x".repeat(5_000),
      cwd: "/",
    });
    expect(out.body.length).toBeLessThan(2_000);
  });
});
