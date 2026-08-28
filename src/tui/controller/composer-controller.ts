import type { Editor, EditorHistoryNavigationResult, EditorInlineDecoration } from "@bubblebrain-ai/pi-tui";
import {
  appendHistoryEntry,
  loadHistoryEntriesSync,
  pushHistoryEntry,
  stepHistory,
  type HistoryEntry,
  type HistoryScope,
} from "../model/input-history.js";
import {
  bareImageFilenameFromPaste,
  extractImagePathTokens,
  ingestClipboardImage,
  ingestImagePath,
} from "../model/image-paste.js";
import type { ImageAttachment } from "../model/image-attachment.js";
import { PasteOperationTracker } from "../model/paste-operation-tracker.js";
import type { SubmitPayload } from "../model/composer-types.js";
import { imageDisplayLabel, stripInlineImageLabels } from "../image-display.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeBackground, themeForeground } from "../model/theme-style.js";

interface ComposerControllerOptions {
  editor: Editor;
  scope: HistoryScope;
  nextImageLabelStart: number;
  onSubmit(payload: SubmitPayload): void;
  onNotice(message: string): void;
  onStateChange(): void;
  onOpenImage?(attachment: ComposerDraftAttachment): void;
  allowImageAttachments?: () => boolean;
  readClipboardImage?: ClipboardImageReader;
  historyFilePath?: string;
  persistHistory?: boolean;
  getTheme?: () => Theme;
}

export type ClipboardImageReader = () => Promise<{
  attachment?: ImageAttachment;
  error?: string;
}>;

export interface ComposerDraftAttachment {
  attachment: ImageAttachment;
  label: string;
}

export interface ComposerDraftSnapshot {
  text: string;
  attachments: ComposerDraftAttachment[];
  imageDisplayStart?: number;
}

const READING_IMAGE_PREFIX = "Reading image";

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    text: entry.text,
    images: entry.images.map((image) => ({ ...image })),
    ...(entry.imageDisplayStart !== undefined ? { imageDisplayStart: entry.imageDisplayStart } : {}),
  };
}

function normalizedScope(scope: HistoryScope): HistoryScope {
  return {
    sessionFile: scope.sessionFile?.trim() || undefined,
    cwd: scope.cwd?.trim() || undefined,
  };
}

function scopesEqual(a: HistoryScope, b: HistoryScope): boolean {
  return a.sessionFile === b.sessionFile && a.cwd === b.cwd;
}

/**
 * Owns semantic composer state that Pi Editor deliberately does not know about:
 * image attachments, asynchronous paste operations and scoped persistent
 * history. Text editing and cursor mechanics remain inside Editor.
 */
export class ComposerController {
  private editor: Editor;
  private scope: HistoryScope;
  private history: HistoryEntry[] = [];
  private historyIndex: number | null = null;
  private historyDraft: HistoryEntry = { text: "", images: [] };
  private attachments: ComposerDraftAttachment[] = [];
  private imageDisplayStart: number | undefined;
  private nextImageLabelStart: number;
  private readonly pasteOperations = new PasteOperationTracker();
  private draftGeneration = 0;
  private applyingEditorState = false;
  private historyNavigationChangePending = false;
  private editorSubmitting = false;
  private disposed = false;
  private recentPreviewLabel?: string;
  private recentPreviewCursorOffset?: number;
  private openImageHandler?: (attachment: ComposerDraftAttachment) => void;

  constructor(private readonly options: ComposerControllerOptions) {
    this.editor = options.editor;
    this.scope = normalizedScope(options.scope);
    this.nextImageLabelStart = Math.max(1, options.nextImageLabelStart);
    this.openImageHandler = options.onOpenImage;
    this.attachEditor(options.editor);
    this.reloadHistory();
  }

  attachEditor(editor: Editor): void {
    if (this.editor !== editor) {
      const previousText = this.editor.getText();
      this.detachEditor(this.editor);
      this.editor = editor;
      this.applyingEditorState = true;
      editor.setText(previousText);
      this.applyingEditorState = false;
    }
    editor.onPaste = (text) => this.handlePaste(text);
    editor.onHistoryNavigate = (direction, currentText) => this.navigateHistory(direction, currentText);
    editor.onChange = () => this.handleEditorChange();
    editor.onCursorMove = () => {
      if (this.applyingEditorState) return;
      this.recentPreviewLabel = undefined;
      this.recentPreviewCursorOffset = undefined;
      this.options.onStateChange();
    };
    editor.onBeforeSubmit = () => {
      this.editorSubmitting = true;
    };
    editor.onSubmit = (text) => this.handleEditorSubmit(text);
    this.syncOpenImageActivation();
    editor.disableSubmit = this.pasteOperations.hasPending;
    this.syncEditorDecorations();
  }

  private detachEditor(editor: Editor): void {
    editor.onPaste = undefined;
    editor.onHistoryNavigate = undefined;
    editor.onChange = undefined;
    editor.onCursorMove = undefined;
    editor.onBeforeSubmit = undefined;
    editor.onSubmit = undefined;
    editor.onInlineDecorationActivate = undefined;
    editor.setInlineDecorations([]);
    editor.disableSubmit = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateDraftAsyncWork();
    this.detachEditor(this.editor);
  }

  pendingImageCount(): number {
    return this.pasteOperations.pendingCount;
  }

  setOpenImageHandler(handler?: (attachment: ComposerDraftAttachment) => void): void {
    this.openImageHandler = handler;
    this.syncOpenImageActivation();
  }

  private syncOpenImageActivation(): void {
    this.editor.onInlineDecorationActivate = this.openImageHandler
      ? (id) => {
          const item = this.attachments.find((candidate) => candidate.label === id);
          if (item) this.openImageHandler?.({ label: item.label, attachment: { ...item.attachment } });
        }
      : undefined;
  }

  /**
   * Explicit keyboard-driven clipboard probe. Image-only clipboards do not
   * produce text for many terminals, so Cmd+V may have no bracketed-paste body
   * and Ctrl+V arrives as a key chord instead of a paste event.
   */
  requestClipboardImagePaste(): void {
    if (this.disposed) return;
    if (this.pasteOperations.hasPending) return;
    if (!(this.options.allowImageAttachments?.() ?? true)) {
      this.options.onNotice("Image attachments are disabled in this runtime session.");
      return;
    }
    this.startClipboardPaste("", true);
  }

  historyTexts(): string[] {
    return this.history.map((entry) => entry.text);
  }

  getText(): string {
    return this.editor.getText();
  }

  snapshotDraft(): ComposerDraftSnapshot {
    return {
      text: this.editor.getText(),
      attachments: this.attachments.map((item) => ({
        label: item.label,
        attachment: { ...item.attachment },
      })),
      ...(this.imageDisplayStart !== undefined ? { imageDisplayStart: this.imageDisplayStart } : {}),
    };
  }

  /** Image whose chip was just inserted, is under the cursor, or is hovered. */
  previewAttachment(): ComposerDraftAttachment | undefined {
    const recentStillAtInsertionPoint = this.recentPreviewCursorOffset === this.editor.getCursorOffset();
    const activeLabel = this.editor.getActiveInlineDecorationId()
      ?? (recentStillAtInsertionPoint ? this.recentPreviewLabel : undefined);
    const item = this.attachments.find((candidate) => candidate.label === activeLabel);
    return item ? { label: item.label, attachment: { ...item.attachment } } : undefined;
  }

  restoreDraft(snapshot: ComposerDraftSnapshot): void {
    this.invalidateDraftAsyncWork();
    this.attachments = snapshot.attachments.map((item) => ({
      label: item.label,
      attachment: { ...item.attachment },
    }));
    this.imageDisplayStart = snapshot.imageDisplayStart;
    this.historyIndex = null;
    this.historyDraft = { text: "", images: [] };
    this.applyingEditorState = true;
    this.editor.setText(snapshot.text);
    this.applyingEditorState = false;
    this.syncEditorDecorations();
    this.options.onStateChange();
  }

  /** Replace the complete draft and invalidate attachments/pastes/history browse. */
  replaceDraft(text: string): void {
    this.invalidateDraftAsyncWork();
    this.attachments = [];
    this.imageDisplayStart = undefined;
    this.historyIndex = null;
    this.historyDraft = { text: "", images: [] };
    this.applyingEditorState = true;
    this.editor.setText(text);
    this.applyingEditorState = false;
    this.recentPreviewLabel = undefined;
    this.recentPreviewCursorOffset = undefined;
    this.syncEditorDecorations();
    this.options.onStateChange();
  }

  /** Rebind persistent history after a successful session transition. */
  setScope(scope: HistoryScope, nextImageLabelStart: number): void {
    const nextScope = normalizedScope(scope);
    const changed = !scopesEqual(this.scope, nextScope);
    this.scope = nextScope;
    this.nextImageLabelStart = Math.max(1, nextImageLabelStart);
    if (!changed) return;
    this.invalidateDraftAsyncWork();
    this.attachments = [];
    this.imageDisplayStart = undefined;
    this.historyIndex = null;
    this.historyDraft = { text: "", images: [] };
    this.reloadHistory();
    this.applyingEditorState = true;
    this.editor.setText("");
    this.applyingEditorState = false;
    this.recentPreviewLabel = undefined;
    this.recentPreviewCursorOffset = undefined;
    this.syncEditorDecorations();
    this.options.onStateChange();
  }

  private reloadHistory(): void {
    if (this.options.persistHistory === false) {
      this.history = [];
      return;
    }
    this.history = loadHistoryEntriesSync({
      scope: this.scope,
      ...(this.options.historyFilePath ? { filePath: this.options.historyFilePath } : {}),
    }).map(cloneHistoryEntry);
  }

  private handleEditorChange(): void {
    if (this.applyingEditorState) return;
    if (this.editorSubmitting) return;
    if (this.historyNavigationChangePending) {
      this.historyNavigationChangePending = false;
      this.syncEditorDecorations();
      return;
    }
    this.recentPreviewLabel = undefined;
    this.recentPreviewCursorOffset = undefined;
    // Editing a recalled entry starts a new draft, matching Editor's native
    // history semantics. Attachments stay attached until their labels are gone.
    if (this.historyIndex !== null) {
      this.historyIndex = null;
      this.historyDraft = { text: "", images: [] };
    }
    if (this.attachments.length > 0) {
      const text = this.editor.getText();
      const retained = this.attachments.filter((item) => text.includes(item.label));
      if (retained.length !== this.attachments.length) {
        if (retained.length === 0) {
          this.attachments = [];
          this.imageDisplayStart = undefined;
        } else {
          const labelStart = this.imageDisplayStart ?? this.nextImageLabelStart;
          this.applyingEditorState = true;
          for (let index = 0; index < retained.length; index++) {
            const item = retained[index]!;
            const nextLabel = imageDisplayLabel(labelStart + index);
            if (item.label !== nextLabel) {
              const current = this.editor.getText();
              const offset = current.indexOf(item.label);
              if (offset >= 0) this.editor.replaceRange(offset, offset + item.label.length, nextLabel);
              item.label = nextLabel;
            }
          }
          this.applyingEditorState = false;
          this.attachments = retained;
          this.imageDisplayStart = labelStart;
        }
        this.options.onStateChange();
      }
    }
    this.syncEditorDecorations();
  }

  private handleEditorSubmit(submittedText: string): void {
    this.editorSubmitting = false;
    const labels = this.attachments.map((item) => item.label);
    const modelText = stripInlineImageLabels(submittedText, labels).trim();
    const isSlashCommand = modelText.startsWith("/");
    const images = isSlashCommand ? [] : this.attachments.map((item) => ({ ...item.attachment }));
    if (!modelText && images.length === 0) {
      this.resetAfterSubmit();
      return;
    }

    if (isSlashCommand && this.attachments.length > 0) {
      this.options.onNotice("Image attachments were ignored for the slash command.");
    }
    const payload: SubmitPayload = {
      text: modelText,
      ...(images.length > 0 && submittedText !== modelText ? { displayText: submittedText } : {}),
      images,
      ...(images.length > 0 && this.imageDisplayStart !== undefined
        ? { imageDisplayStart: this.imageDisplayStart }
        : {}),
    };

    const historyEntry: HistoryEntry = {
      // History restores the draft surface, not the provider prompt. Keep the
      // chip exactly where it was submitted and derive modelText again on the
      // next submit.
      text: images.length > 0 ? submittedText : modelText,
      images,
      ...(images.length > 0 && this.imageDisplayStart !== undefined
        ? { imageDisplayStart: this.imageDisplayStart }
        : {}),
    };
    const nextHistory = pushHistoryEntry(this.history, historyEntry);
    if (nextHistory !== this.history) {
      this.history = nextHistory;
      if (this.options.persistHistory !== false) {
        appendHistoryEntry(historyEntry, {
          scope: this.scope,
          ...(this.options.historyFilePath ? { filePath: this.options.historyFilePath } : {}),
        });
      }
    }

    if (images.length > 0) {
      this.nextImageLabelStart = Math.max(
        this.nextImageLabelStart,
        (this.imageDisplayStart ?? this.nextImageLabelStart) + images.length,
      );
    }
    this.resetAfterSubmit();
    this.options.onSubmit(payload);
  }

  private resetAfterSubmit(): void {
    this.invalidateDraftAsyncWork();
    this.attachments = [];
    this.imageDisplayStart = undefined;
    this.recentPreviewLabel = undefined;
    this.recentPreviewCursorOffset = undefined;
    this.syncEditorDecorations();
    this.historyIndex = null;
    this.historyDraft = { text: "", images: [] };
    this.options.onStateChange();
  }

  private navigateHistory(
    direction: "up" | "down",
    currentText: string,
  ): EditorHistoryNavigationResult | undefined {
    if (this.pasteOperations.hasPending) return undefined;
    const currentEntry: HistoryEntry = {
      text: currentText,
      images: this.attachments.map((item) => ({ ...item.attachment })),
      ...(this.imageDisplayStart !== undefined ? { imageDisplayStart: this.imageDisplayStart } : {}),
    };
    const result = stepHistory(
      {
        history: this.history,
        index: this.historyIndex,
        draft: this.historyDraft,
      },
      direction,
      currentEntry,
    );
    if (!result.changed) return undefined;

    if (this.historyIndex === null && result.index !== null) {
      this.historyDraft = cloneHistoryEntry(currentEntry);
    }
    const restoredImages = (result.images ?? []).map((image) => ({ ...image }));
    const labelStart = restoredImages.length > 0
      ? result.imageDisplayStart ?? this.nextImageLabelStart
      : undefined;
    this.attachments = restoredImages.map((attachment, index) => ({
      attachment,
      label: imageDisplayLabel((labelStart ?? 1) + index),
    }));
    this.imageDisplayStart = labelStart;
    this.historyIndex = result.index;
    if (result.index === null) this.historyDraft = { text: "", images: [] };

    const labels = this.attachments.map((item) => item.label);
    const restoredText = labels.length > 0 && !labels.some((label) => result.text.includes(label))
      ? `${labels.join(" ")} ${result.text}`.trimEnd()
      : result.text;
    this.historyNavigationChangePending = true;
    this.options.onStateChange();
    return { text: restoredText, active: result.index !== null };
  }

  private handlePaste(raw: string): boolean {
    if (this.disposed) return false;
    const clean = raw
      .replace(/\x1b\[I$/, "")
      .replace(/\x1b\[O$/, "")
      .replace(/\r\n?/g, "\n");
    const allowImages = this.options.allowImageAttachments?.() ?? true;
    const pathTokens = extractImagePathTokens(clean);
    const bareName = bareImageFilenameFromPaste(clean);
    const imageIntent = clean.length === 0 || pathTokens.length > 0 || bareName !== null;
    if (!imageIntent) return false;

    if (!allowImages) {
      this.options.onNotice("Image attachments are disabled in this runtime session.");
      return true;
    }
    if (clean.length === 0 || bareName !== null) {
      this.startClipboardPaste(clean);
      return true;
    }
    this.startPathPaste(clean, pathTokens);
    return true;
  }

  private beginPastePlaceholder(): { id: number; marker: string; generation: number } {
    const id = this.pasteOperations.begin();
    const marker = `[${READING_IMAGE_PREFIX} #${id}…]`;
    this.editor.disableSubmit = true;
    this.editor.insertTextAtCursor(`${marker} `);
    this.options.onStateChange();
    return { id, marker, generation: this.draftGeneration };
  }

  private finishPaste(id: number): void {
    this.pasteOperations.finish(id);
    this.editor.disableSubmit = this.pasteOperations.hasPending;
    this.options.onStateChange();
  }

  private replacePasteMarker(
    marker: string,
    replacement: string,
    removeTrailingSeparator = false,
  ): boolean {
    const text = this.editor.getText();
    const start = text.indexOf(marker);
    if (start < 0) return false;
    const markerEnd = start + marker.length;
    const end = removeTrailingSeparator && text[markerEnd] === " "
      ? markerEnd + 1
      : markerEnd;
    this.applyingEditorState = true;
    this.editor.replaceRange(start, end, replacement);
    this.applyingEditorState = false;
    if (this.recentPreviewLabel && replacement.includes(this.recentPreviewLabel)) {
      this.recentPreviewCursorOffset = this.editor.getCursorOffset();
    }
    return true;
  }

  private startClipboardPaste(fallbackText: string, notifyWhenEmpty = false): void {
    const pending = this.beginPastePlaceholder();
    const readClipboardImage = this.options.readClipboardImage ?? ingestClipboardImage;
    void readClipboardImage()
      .then(({ attachment, error }) => {
        if (this.disposed || pending.generation !== this.draftGeneration) return;
        if (!attachment) {
          this.replacePasteMarker(pending.marker, fallbackText, fallbackText.length === 0);
          if (notifyWhenEmpty && error === "clipboard has no image") {
            this.options.onNotice("Clipboard does not contain a supported image.");
          } else if (error && error !== "clipboard has no image") {
            this.options.onNotice(`Image paste failed: ${error}`);
          }
          return;
        }
        if (!this.editor.getText().includes(pending.marker)) return;
        const item = this.registerAttachment(attachment);
        this.replacePasteMarker(pending.marker, item.label);
      })
      .finally(() => this.finishPaste(pending.id));
  }

  private startPathPaste(
    pastedText: string,
    tokens: ReturnType<typeof extractImagePathTokens>,
  ): void {
    const pending = this.beginPastePlaceholder();
    void Promise.all(tokens.map(async (token) => ({ token, result: await ingestImagePath(token.rawPath) })))
      .then((results) => {
        if (this.disposed || pending.generation !== this.draftGeneration) return;
        if (!this.editor.getText().includes(pending.marker)) return;

        let replacement = "";
        let cursor = 0;
        for (const { token, result } of results) {
          replacement += pastedText.slice(cursor, token.start);
          if (result.attachment) {
            replacement += this.registerAttachment(result.attachment).label;
          } else {
            replacement += pastedText.slice(token.start, token.end);
            this.options.onNotice(`${token.rawPath}: ${result.error ?? "could not attach image"}`);
          }
          cursor = token.end;
        }
        replacement += pastedText.slice(cursor);
        this.replacePasteMarker(pending.marker, replacement);
      })
      .finally(() => this.finishPaste(pending.id));
  }

  private registerAttachment(attachment: ImageAttachment): ComposerDraftAttachment {
    if (this.imageDisplayStart === undefined) this.imageDisplayStart = this.nextImageLabelStart;
    const item = {
      attachment: { ...attachment },
      label: imageDisplayLabel(this.imageDisplayStart + this.attachments.length),
    };
    this.attachments.push(item);
    this.recentPreviewLabel = item.label;
    this.syncEditorDecorations();
    return item;
  }

  private syncEditorDecorations(): void {
    const decorations: EditorInlineDecoration[] = this.attachments.map((item) => ({
      id: item.label,
      text: item.label,
      style: (text, state) => {
        const theme = this.options.getTheme?.() ?? darkTheme;
        const background = state.focused
          ? theme.traceSelectedBg
          : state.hovered
            ? theme.traceHoverBg
            : theme.backgroundElement;
        return themeForeground(theme.inputText, themeBackground(background, text));
      },
    }));
    this.editor.setInlineDecorations(decorations);
  }

  private invalidateDraftAsyncWork(): void {
    this.draftGeneration++;
    this.pasteOperations.invalidateAll();
    this.editor.disableSubmit = false;
  }
}
