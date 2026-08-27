import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth, type TUI } from "@bubblebrain-ai/pi-tui";
import {
  FeedbackDialogComponent,
  type FeedbackDialogResult,
} from "../tui/components/feedback-dialog.js";
import type { FeedbackPayload } from "../feedback/types.js";

const base: Omit<FeedbackPayload, "description"> = {
  version: "0.0.52",
  platform: "darwin",
  arch: "arm64",
  nodeVersion: "v24.0.0",
  provider: "test-provider",
  model: "test-model",
  transcript: [{ role: "user", content: "hello" }],
  submittedAt: 123,
  clientId: "feedback-test",
};

function createDialog(options: {
  initialDescription?: string;
  rows?: number;
  payloadBase?: Omit<FeedbackPayload, "description">;
  submit?: (payload: FeedbackPayload) => Promise<{ url: string; number: number }>;
} = {}) {
  const rows = options.rows ?? 18;
  const tui = {
    terminal: { rows },
    requestRender: vi.fn(),
  } as unknown as TUI;
  const results: FeedbackDialogResult[] = [];
  const dismiss = vi.fn();
  const render = vi.fn();
  const submit = options.submit ?? vi.fn<(payload: FeedbackPayload) => Promise<{ url: string; number: number }>>(
    async () => ({ url: "https://github.com/example/issues/42", number: 42 }),
  );
  const dialog = new FeedbackDialogComponent(
    tui,
    options.payloadBase ?? base,
    options.initialDescription ?? "cursor jumps",
    {
      getTerminalRows: () => rows,
      submit,
      onDismiss: dismiss,
      onResult: (result) => results.push(result),
      onRender: render,
    },
  );
  dialog.focused = true;
  return { dialog, submit, results, dismiss, render };
}

describe("feedback dialog", () => {
  it("renders a bounded full-width editor with the public issue warning", () => {
    for (const [width, rows] of [[100, 30], [32, 8], [16, 4]] as const) {
      const { dialog } = createDialog({ rows });
      const rendered = dialog.render(width);
      expect(rendered.length).toBeLessThanOrEqual(Math.min(22, Math.max(1, rows - 1)));
      expect(rendered.every((line) => visibleWidth(line) === width)).toBe(true);
    }
    const plain = createDialog().dialog.render(100).map(stripTerminalSequences).join("\n");
    expect(plain).toContain("Send feedback");
    expect(plain).toContain("PUBLIC GitHub issue");
    expect(plain).toContain("1 messages");
  });

  it("edits multiple lines, redacts secrets, and submits the actual payload", async () => {
    const submit = vi.fn<(payload: FeedbackPayload) => Promise<{ url: string; number: number }>>(
      async () => ({ url: "https://github.com/example/issues/7", number: 7 }),
    );
    const { dialog, results } = createDialog({
      initialDescription: `broken at ${homedir()}`,
      submit,
    });
    dialog.handleInput("\r");
    dialog.handleInput("token sk-abcdefghijklmnopqrstuvwxyz123456");
    dialog.handleInput("\x13");

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const payload = submit.mock.calls[0]![0];
    expect(payload.description).toContain("broken at ~\ntoken sk-***REDACTED***");
    expect(payload.transcript).toEqual(base.transcript);
    await vi.waitFor(() => expect(results).toEqual([{
      kind: "success",
      url: "https://github.com/example/issues/7",
      number: 7,
    }]));
    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain("Issue #7 was created");
  });

  it("shows the exact payload preview and returns to editing with Tab", () => {
    const { dialog } = createDialog({ initialDescription: "preview me" });
    dialog.handleInput("\t");
    const preview = dialog.render(100).map(stripTerminalSequences).join("\n");
    expect(preview).toContain("Payload preview");
    expect(preview).toContain('"description": "preview me"');
    for (let index = 0; index < 30; index += 1) dialog.handleInput("\x1b[B");
    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain('"clientId": "feedback-test"');
    dialog.handleInput("\t");
    expect(dialog.render(100).map(stripTerminalSequences).join("\n")).toContain("Describe what happened");
  });

  it("requires either a description or collected transcript", () => {
    const submit = vi.fn<(payload: FeedbackPayload) => Promise<{ url: string; number: number }>>(
      async () => ({ url: "https://example.test", number: 1 }),
    );
    const { dialog } = createDialog({
      initialDescription: "",
      payloadBase: { ...base, transcript: [] },
      submit,
    });
    dialog.handleInput("\x04");
    expect(submit).not.toHaveBeenCalled();
    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain("Describe the issue before submitting.");
  });

  it("renders submission errors and dismisses only after acknowledgement", async () => {
    const { dialog, results, dismiss } = createDialog({
      submit: vi.fn<(payload: FeedbackPayload) => Promise<{ url: string; number: number }>>(
        async () => { throw new Error("network unavailable"); },
      ),
    });
    dialog.handleInput("\x04");
    await vi.waitFor(() => expect(results).toEqual([{ kind: "error", message: "network unavailable" }]));
    expect(dialog.render(100).map(stripTerminalSequences).join("\n"))
      .toContain("Feedback failed to submit");
    expect(dismiss).not.toHaveBeenCalled();
    dialog.handleInput("\r");
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("cancels without submitting and reports cancellation exactly once", () => {
    const { dialog, submit, results, dismiss } = createDialog();
    dialog.handleInput("\x1b");
    dialog.handleInput("\x1b");
    expect(submit).not.toHaveBeenCalled();
    expect(results).toEqual([{ kind: "cancelled" }]);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
