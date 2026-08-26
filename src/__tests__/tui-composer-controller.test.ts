import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, TuiMainScreen } from "@bubblebrain-ai/pi-tui";
import { VirtualTerminal } from "@bubblebrain-ai/pi-tui/testing";
import { ComposerController } from "../tui/controller/composer-controller.js";
import { COMPOSER_EDITOR_OPTIONS, COMPOSER_EDITOR_THEME } from "../tui/composer-style.js";
import type { SubmitPayload } from "../tui/model/composer-types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(readClipboardImage?: () => Promise<{
  attachment?: {
    base64: string;
    mediaType: string;
    bytes: number;
    dataUrl: string;
    filename?: string;
  };
  error?: string;
}>, onOpenImage?: (item: { label: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "bubble-pi-composer-"));
  tempDirs.push(dir);
  const historyFilePath = join(dir, "input-history.jsonl");
  const terminal = new VirtualTerminal(100, 30);
  const tui = new TuiMainScreen(terminal);
  const editor = new Editor(tui, COMPOSER_EDITOR_THEME, COMPOSER_EDITOR_OPTIONS);
  const submissions: SubmitPayload[] = [];
  const notices: string[] = [];
  const composer = new ComposerController({
    editor,
    scope: { sessionFile: "/sessions/a.jsonl", cwd: "/repo" },
    nextImageLabelStart: 1,
    historyFilePath,
    readClipboardImage,
    onSubmit: (payload) => submissions.push(payload),
    onNotice: (message) => notices.push(message),
    onStateChange: () => {},
    onOpenImage,
  });
  return { dir, historyFilePath, editor, composer, submissions, notices };
}

async function waitForPaste(composer: ComposerController): Promise<void> {
  for (let attempt = 0; attempt < 100 && composer.pendingImageCount() > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(composer.pendingImageCount()).toBe(0);
}

describe("Pi composer semantic state", () => {
  it("probes an image-only clipboard when paste is requested by keyboard", async () => {
    const readClipboardImage = vi.fn(async () => ({
      attachment: {
        base64: "cG5n",
        mediaType: "image/png",
        bytes: 3,
        dataUrl: "data:image/png;base64,cG5n",
        filename: "clipboard.png",
      },
    }));
    const { editor, composer } = fixture(readClipboardImage);

    composer.requestClipboardImagePaste();
    expect(editor.getText()).toContain("Reading image");
    await waitForPaste(composer);

    expect(readClipboardImage).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("[Image #1] ");
    composer.dispose();
  });

  it("reports an explicit clipboard shortcut that contains no image", async () => {
    const { editor, composer, notices } = fixture(async () => ({ error: "clipboard has no image" }));

    composer.requestClipboardImagePaste();
    await waitForPaste(composer);

    expect(editor.getText()).toBe("");
    expect(notices).toContain("Clipboard does not contain a supported image.");
    composer.dispose();
  });

  it("exposes the inserted chip preview and opens it with Enter while focused", async () => {
    const opened: string[] = [];
    const { editor, composer, submissions } = fixture(async () => ({
      attachment: {
        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        mediaType: "image/png",
        bytes: 24,
        dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        filename: "clipboard.png",
      },
    }), (item) => opened.push(item.label));

    composer.requestClipboardImagePaste();
    await waitForPaste(composer);
    expect(composer.previewAttachment()?.label).toBe("[Image #1]");

    editor.handleInput("\x1b[D"); // from trailing separator to the chip's right edge
    expect(editor.getActiveInlineDecorationId()).toBe("[Image #1]");
    editor.handleInput("\r");
    expect(opened).toEqual(["[Image #1]"]);
    expect(submissions).toEqual([]);

    editor.handleInput("\x1b[C");
    expect(composer.previewAttachment()).toBeUndefined();
    composer.dispose();
  });

  it("ingests a pasted image path, blocks early submit, and emits a complete payload", async () => {
    const { dir, historyFilePath, editor, composer, submissions } = fixture();
    const imagePath = join(dir, "sample image.png");
    writeFileSync(imagePath, Buffer.from("small-png-fixture"));

    editor.handleInput(`\x1b[200~${imagePath.replaceAll(" ", "\\ ")}\x1b[201~`);
    expect(editor.getText()).toContain("Reading image");
    editor.handleInput("\r");
    expect(submissions).toEqual([]);

    await waitForPaste(composer);
    expect(editor.getText()).toContain("[Image #1]");
    editor.insertTextAtCursor("describe this");
    editor.handleInput("\r");

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.text).toBe("describe this");
    expect(submissions[0]?.displayText).toContain("[Image #1]");
    expect(submissions[0]?.images).toHaveLength(1);
    expect(submissions[0]?.images[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
    const persisted = JSON.parse(readFileSync(historyFilePath, "utf8").trim());
    expect(persisted.images).toHaveLength(1);
    expect(persisted.text).toBe("[Image #1] describe this");
    composer.dispose();

    const restoredEditor = new Editor(
      new TuiMainScreen(new VirtualTerminal(100, 30)),
      COMPOSER_EDITOR_THEME,
      COMPOSER_EDITOR_OPTIONS,
    );
    const restoredSubmissions: SubmitPayload[] = [];
    const restored = new ComposerController({
      editor: restoredEditor,
      scope: { sessionFile: "/sessions/a.jsonl", cwd: "/repo" },
      nextImageLabelStart: 2,
      historyFilePath,
      onSubmit: (payload) => restoredSubmissions.push(payload),
      onNotice: () => {},
      onStateChange: () => {},
    });
    restoredEditor.handleInput("\x1b[A");
    expect(restoredEditor.getText()).toBe("[Image #1] describe this");
    expect(restoredEditor.getCursor()).toEqual({
      line: 0,
      col: "[Image #1] describe this".length,
    });
    restoredEditor.handleInput("\r");
    expect(restoredSubmissions[0]?.images).toHaveLength(1);
    expect(restoredSubmissions[0]?.text).toBe("describe this");
    restored.dispose();
  });

  it("reloads persistent history after restart and restores the unsent draft", () => {
    const first = fixture();
    first.editor.insertTextAtCursor("persist me");
    first.editor.handleInput("\r");
    first.composer.dispose();

    const secondTerminal = new VirtualTerminal(100, 30);
    const secondEditor = new Editor(
      new TuiMainScreen(secondTerminal),
      COMPOSER_EDITOR_THEME,
      COMPOSER_EDITOR_OPTIONS,
    );
    const second = new ComposerController({
      editor: secondEditor,
      scope: { sessionFile: "/sessions/a.jsonl", cwd: "/repo" },
      nextImageLabelStart: 1,
      historyFilePath: first.historyFilePath,
      onSubmit: () => {},
      onNotice: () => {},
      onStateChange: () => {},
    });
    secondEditor.insertTextAtCursor("unsent draft");
    secondEditor.handleInput("\x1b[A"); // first Up moves to the line start
    secondEditor.handleInput("\x1b[A"); // second Up enters history
    expect(secondEditor.getText()).toBe("persist me");
    expect(secondEditor.getCursor()).toEqual({ line: 0, col: "persist me".length });
    secondEditor.handleInput("\x1b[B");
    expect(secondEditor.getText()).toBe("unsent draft");
    expect(secondEditor.getCursor()).toEqual({ line: 0, col: "unsent draft".length });
    second.dispose();
  });

  it("reloads history per session and never leaks entries across a switch", () => {
    const { editor, composer } = fixture();
    editor.insertTextAtCursor("session A");
    editor.handleInput("\r");

    composer.setScope({ sessionFile: "/sessions/b.jsonl", cwd: "/repo" }, 1);
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("");

    composer.setScope({ sessionFile: "/sessions/a.jsonl", cwd: "/repo" }, 1);
    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("session A");
    composer.dispose();
  });
});
