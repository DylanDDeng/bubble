import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDatabase, runMemoryPhase1, runMemoryPhase2 } from "../memory/index.js";
import type { SessionLogEntry } from "../session.js";
import type { Message } from "../types.js";

let root: string;
let cwd: string;
const originalHome = process.env.BUBBLE_HOME;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bubble-memory-checkpoint-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd);
  process.env.BUBBLE_HOME = join(root, "home");
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.BUBBLE_HOME;
  else process.env.BUBBLE_HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

function user(content: string): SessionLogEntry {
  return { id: "user", type: "user_message", message: { role: "user", content }, timestamp: 1 };
}
function checkpoint(messages: Message[], summary?: string): SessionLogEntry {
  return { id: "checkpoint", type: "context_checkpoint", timestamp: 1,
    checkpoint: { version: 1, compactionId: "checkpoint", reason: "manual", messages, summary } };
}
function archive(entries: SessionLogEntry[], name = "session.jsonl"): string {
  const dir = join(process.env.BUBBLE_HOME!, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, [{ id: "metadata", type: "metadata", metadata: { cwd }, timestamp: 1 }, ...entries]
    .map((entry, i) => JSON.stringify({ ...entry, id: String(i) })).join("\n") + "\n");
  return file;
}
const oldArchive = () => Array.from({ length: 40 }, (_, i) => user(`OLD_ORIGINAL_${i} ${"x".repeat(2_900)}`));
const response = JSON.stringify({ raw_memory: "Current durable decision", rollout_summary: "Current summary" });
async function extract() {
  let prompt = "";
  const complete = vi.fn(async (messages: Message[]) => {
    prompt = String(messages[1].content).split("Rollout transcript:\n")[1];
    expect(String(messages[0].content)).toContain("do not retain revoked facts");
    return response;
  });
  const result = await runMemoryPhase1({ cwd, model: "test", complete });
  expect(result.succeeded).toBe(1);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(prompt.length).toBeLessThanOrEqual(70_000);
  return prompt;
}

describe("checkpoint-aware memory extraction", () => {
  it("sends the effective summary, retained projection and latest revocation instead of >70k originals", async () => {
    archive([
      ...oldArchive(), user("REVOKED_OLD_FACT: deploy to legacy-host"), user("RETAINED_DECISION"),
      checkpoint([
        { role: "meta", kind: "compaction-summary", content: "Previous conversation summary: CURRENT_SUMMARY" },
        { role: "user", content: "RETAINED_DECISION" },
        { role: "assistant", content: "Done", toolCalls: [{ id: "t", name: "read", arguments: '{"path":"config"}' }] },
        { role: "tool", toolCallId: "t", content: "RETAINED_TOOL_EVIDENCE" },
      ], "CURRENT_SUMMARY"),
      user("NEW_DECISION: legacy-host is revoked; use new-host only."),
    ]);
    const prompt = await extract();
    expect(prompt).toContain("CURRENT_SUMMARY");
    expect(prompt.match(/CURRENT_SUMMARY/g)).toHaveLength(1);
    expect(prompt.match(/RETAINED_DECISION/g)).toHaveLength(1);
    expect(prompt).toContain("RETAINED_TOOL_EVIDENCE");
    expect(prompt).toContain("[tool_call:read]");
    expect(prompt).toContain("NEW_DECISION: legacy-host is revoked; use new-host only.");
    expect(prompt).not.toContain("OLD_ORIGINAL");
    expect(prompt).not.toContain("REVOKED_OLD_FACT");
  });

  it("bounds large retained projections while protecting summary and newest evidence", async () => {
    archive([...oldArchive(), checkpoint([
      { role: "meta", kind: "compaction-summary", content: "PROTECTED_SUMMARY" },
      ...Array.from({ length: 40 }, (_, i): Message => ({ role: "user", content: `RETAINED_${i} ${"r".repeat(2_900)}` })),
      { role: "user", content: "RECENT_RETAINED_DECISION" },
    ]), user("SUFFIX_CORRECTION")]);
    const prompt = await extract();
    expect(prompt).toContain("PROTECTED_SUMMARY");
    expect(prompt).toContain("RECENT_RETAINED_DECISION");
    expect(prompt).toContain("SUFFIX_CORRECTION");
    expect(prompt).not.toContain("RETAINED_0 ");
    expect(prompt.indexOf("PROTECTED_SUMMARY")).toBeLessThan(prompt.indexOf("SUFFIX_CORRECTION"));
  });

  it("uses only the latest checkpoint per clear segment without erasing pre-clear durable memory", async () => {
    archive([...oldArchive(),
      checkpoint([{ role: "user", content: "SUPERSEDED_CHECKPOINT" }], "SUPERSEDED_SUMMARY"),
      user("SUPERSEDED_SUFFIX"),
      checkpoint([{ role: "user", content: "PRE_CLEAR_RETAINED" }], "PRE_CLEAR_DURABLE_SUMMARY"),
      user("PRE_CLEAR_FINAL_DECISION"),
      { id: "clear", type: "marker", kind: "conversation_clear", value: "clear", timestamp: 1 },
      ...oldArchive(),
      checkpoint([{ role: "user", content: "POST_CLEAR_RETAINED" }], "POST_CLEAR_SUMMARY"),
      user("POST_CLEAR_FINAL_DECISION"),
      ...oldArchive(), user("NEWEST_EVIDENCE"),
    ]);
    const prompt = await extract();
    for (const text of ["PRE_CLEAR_DURABLE_SUMMARY", "PRE_CLEAR_RETAINED", "PRE_CLEAR_FINAL_DECISION", "POST_CLEAR_SUMMARY", "NEWEST_EVIDENCE"]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).not.toContain("SUPERSEDED");
    expect(prompt).toContain("[conversation segment 2]");
  });

  it("selects newest evidence even without checkpoints", async () => {
    archive([...oldArchive(), user("LATEST_REVOCATION")]);
    const prompt = await extract();
    expect(prompt).toContain("LATEST_REVOCATION");
    expect(prompt).not.toContain("OLD_ORIGINAL_0 ");
  });

  it("excludes diagnostics and runtime reminders while retaining projected summaries and redacting outputs", async () => {
    const file = archive([...oldArchive(), checkpoint([
      { role: "system", content: "HOST_SECRET_PROMPT" },
      { role: "meta", kind: "runtime-context", content: "RUNTIME_META_SECRET" } as Message,
      { role: "user", content: '<bubble_internal_context kind="compaction-summary">Previous conversation summary: PROJECTED_SUMMARY</bubble_internal_context>' },
      { role: "user", content: '<bubble_internal_reminder kind="goal">RUNTIME_USER_SECRET</bubble_internal_reminder>' },
      { role: "assistant", content: 'Visible answer <bubble_internal_reminder kind="goal">RUNTIME_ASSISTANT_SECRET</bubble_internal_reminder>', reasoning: "HIDDEN_REASONING" },
    ]),
    user('<bubble_internal_reminder kind="goal">SUFFIX_RUNTIME_SECRET</bubble_internal_reminder>'),
    { id: "error", type: "provider_error", timestamp: 1, error: { message: "DIAGNOSTIC_SECRET" } } as SessionLogEntry]);
    const complete = vi.fn(async (messages: Message[]) => {
      const prompt = String(messages[1].content);
      expect(prompt).toContain("PROJECTED_SUMMARY");
      expect(prompt).toContain("Visible answer");
      expect(prompt).not.toMatch(/SECRET|HIDDEN_REASONING/);
      return JSON.stringify({ raw_memory: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456", rollout_summary: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456" });
    });
    const result = await runMemoryPhase1({ cwd, model: "test", complete });
    expect(result.errors).toEqual([]);
    expect(result.succeeded).toBe(1);
    const db = new MemoryDatabase(cwd);
    expect(db.getStage1Output(file)?.rawMemory).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(db.getStage1Output(file)?.rolloutSummary).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    db.close();
  });

  it("invalidates unchanged old extraction caches and phase-2 retention, then caches the new identity", async () => {
    const file = archive([...oldArchive(), checkpoint([{ role: "user", content: "CURRENT_DECISION" }], "CURRENT_SUMMARY")]);
    const db = new MemoryDatabase(cwd);
    db.upsertStage1Output({ sessionFile: file, cwd, entryCount: 42, sourceUpdatedAt: statSync(file).mtime.toISOString(),
      generatedAt: new Date().toISOString(), rawMemory: "STALE_FACT", rolloutSummary: "STALE_FACT" });
    db.markSelectedForPhase2([db.getStage1Output(file)!]);
    expect(db.getStage1Output(file)?.selectedForPhase2).toBe(true);
    db.close();
    await extract();
    const check = new MemoryDatabase(cwd);
    expect(check.getStage1Output(file)?.extractorVersion).toBe("checkpoint-segments-v1");
    expect(check.getStage1Output(file)?.selectedForPhase2).toBe(false);
    check.close();
    const complete = vi.fn(async () => response);
    expect((await runMemoryPhase1({ cwd, model: "test", complete })).skipped).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    const phase2 = await runMemoryPhase2({ cwd, model: "test", complete: async messages => {
      expect(String(messages[1].content)).toContain("Retained from previous successful Phase 2 selection: 0");
      expect(String(messages[1].content)).not.toContain("STALE_FACT");
      return JSON.stringify({ memory_md: "Current memory", memory_summary_md: "Current summary" });
    } });
    expect(phase2.status).toBe("succeeded");
  });

  it("preserves legacy summary segments across clears", async () => {
    archive([
      ...oldArchive(),
      { id: "summary", type: "summary", summary: "LEGACY_DURABLE_SUMMARY", timestamp: 1 },
      user("LEGACY_SUFFIX"),
      { id: "clear", type: "marker", kind: "conversation_clear", value: "clear", timestamp: 1 },
      user("NEW_CONVERSATION"),
    ]);
    const prompt = await extract();
    expect(prompt).toContain("LEGACY_DURABLE_SUMMARY");
    expect(prompt).toContain("LEGACY_SUFFIX");
    expect(prompt).toContain("NEW_CONVERSATION");
    expect(prompt).not.toContain("OLD_ORIGINAL");
  });

  it("still skips disabled sessions and missing-model runs", async () => {
    const file = archive([...oldArchive(), checkpoint([{ role: "user", content: "DISABLED" }])]);
    const db = new MemoryDatabase(cwd);
    db.setThreadMemoryMode(file, "disabled");
    db.close();
    const complete = vi.fn(async () => response);
    const disabled = await runMemoryPhase1({ cwd, model: "test", complete });
    expect(disabled.skipped).toBe(1);
    expect(disabled.claimed).toBe(0);
    const noModel = await runMemoryPhase1({ cwd, complete });
    expect(noModel.errors).toEqual(["no active model"]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not make checkpoint-only or diagnostics-only sessions eligible", async () => {
    archive([checkpoint([{ role: "user", content: "NOT_ELIGIBLE" }], "NOT_ELIGIBLE")], "checkpoint.jsonl");
    archive(Array.from({ length: 5 }, (): SessionLogEntry => ({ id: "error", type: "provider_error", timestamp: 1,
      error: { message: "NOT_ELIGIBLE" } } as SessionLogEntry)), "diagnostics.jsonl");
    const complete = vi.fn(async () => response);
    const result = await runMemoryPhase1({ cwd, model: "test", complete });
    expect(result.skipped).toBe(2);
    expect(result.claimed).toBe(0);
    expect(complete).not.toHaveBeenCalled();
  });
});
