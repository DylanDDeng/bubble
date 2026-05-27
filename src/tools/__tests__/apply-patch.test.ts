import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalController, ApprovalDecision, ApprovalRequest } from "../../approval/types.js";
import { createApplyPatchTool } from "../apply-patch.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bubble-apply-patch-"));
}

function makeApproval(decisionFor: (req: ApprovalRequest) => ApprovalDecision | Promise<ApprovalDecision>): {
  controller: ApprovalController;
  requests: ApprovalRequest[];
} {
  const requests: ApprovalRequest[] = [];
  return {
    controller: {
      request: async (req) => {
        requests.push(req);
        return decisionFor(req);
      },
      checkRules: () => ({ decision: "ask" }),
    },
    requests,
  };
}

describe("apply_patch tool", () => {
  it("applies an update patch and returns combined diff metadata", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "alpha\nbeta\n", "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
 alpha
-beta
+BETTA
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(result.status).toBe("success");
    expect(readFileSync(file, "utf-8")).toBe("alpha\nBETTA\n");
    expect(result.metadata).toMatchObject({
      kind: "patch",
      paths: [file],
      addedLines: 1,
      removedLines: 1,
    });
    expect(result.metadata?.diff).toContain("-beta");
    expect(result.metadata?.diff).toContain("+BETTA");
  });

  it("adds and deletes files in one patch", async () => {
    const dir = tempDir();
    const oldFile = join(dir, "old.txt");
    const newFile = join(dir, "new.txt");
    writeFileSync(oldFile, "remove me\n", "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Add File: new.txt
+created
*** Delete File: old.txt
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(existsSync(oldFile)).toBe(false);
    expect(readFileSync(newFile, "utf-8")).toBe("created\n");
  });

  it("moves a file and updates its content", async () => {
    const dir = tempDir();
    const source = join(dir, "old.txt");
    const target = join(dir, "nested", "new.txt");
    writeFileSync(source, "old name\n", "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: nested/new.txt
@@
-old name
+new name
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, "utf-8")).toBe("new name\n");
  });

  it("uses normalized matching for markdown table alignment differences", async () => {
    const dir = tempDir();
    const file = join(dir, "table.md");
    writeFileSync(
      file,
      "| Layer   | Choice                  |\n| ------- | ----------------------- |\n| Runtime | Node 20                |\n",
      "utf-8",
    );

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: table.md
@@
-| Runtime | Node 20 |
+| Runtime | Node 22 |
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("normalized matching");
    expect(readFileSync(file, "utf-8")).toContain("| Runtime | Node 22 |");
  });

  it("rejects ambiguous normalized matches without modifying the file", async () => {
    const dir = tempDir();
    const file = join(dir, "ambiguous.md");
    const original =
      "| Name    | Value   |\n| ------- | ------- |\n| Runtime  | Node 20  |\n| Runtime   | Node 20   |\n";
    writeFileSync(file, original, "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: ambiguous.md
@@
-| Runtime | Node 20 |
+| Runtime | Node 22 |
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("matched 2 normalized locations");
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  it("does not partially write files when dry-run planning fails", async () => {
    const dir = tempDir();
    const existing = join(dir, "a.txt");
    const added = join(dir, "new.txt");
    writeFileSync(existing, "one\n", "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Add File: new.txt
+created
*** Update File: a.txt
@@
-missing
+two
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.status).toBe("no_match");
    expect(readFileSync(existing, "utf-8")).toBe("one\n");
    expect(existsSync(added)).toBe(false);
  });

  it("does not write when approval rejects the patch", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "alpha\n", "utf-8");
    const { controller, requests } = makeApproval(() => ({ action: "reject", feedback: "smaller change" }));

    const tool = createApplyPatchTool(dir, controller);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("rejected");
    expect(result.content).toContain("smaller change");
    expect(readFileSync(file, "utf-8")).toBe("alpha\n");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ type: "patch", paths: [file] });
    if (requests[0].type === "patch") {
      expect(requests[0].diff).toContain("-alpha");
      expect(requests[0].diff).toContain("+ALPHA");
    }
  });

  it("rechecks freshness after approval and refuses stale writes", async () => {
    const dir = tempDir();
    const file = join(dir, "a.txt");
    writeFileSync(file, "alpha\n", "utf-8");
    const { controller } = makeApproval(() => {
      writeFileSync(file, "external\n", "utf-8");
      return { action: "approve" };
    });

    const tool = createApplyPatchTool(dir, controller);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: a.txt
@@
-alpha
+ALPHA
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.content).toContain("changed after the patch was prepared");
    expect(readFileSync(file, "utf-8")).toBe("external\n");
  });

  it("preserves BOM and CRLF line endings", async () => {
    const dir = tempDir();
    const file = join(dir, "crlf.txt");
    writeFileSync(file, "\uFEFFfirst\r\nsecond\r\n", "utf-8");

    const tool = createApplyPatchTool(dir);
    const result = await tool.execute({
      patch: `*** Begin Patch
*** Update File: crlf.txt
@@
-second
+changed
*** End Patch`,
    }, { cwd: dir });

    expect(result.isError).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe("\uFEFFfirst\r\nchanged\r\n");
  });
});
