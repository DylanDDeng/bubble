import chalk from "chalk";
import {
  Image,
  getCapabilities,
  getImageDimensions,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { ComposerDraftAttachment } from "../controller/composer-controller.js";
import type { DisplayImageAttachment } from "../model/image-attachment.js";
import { darkTheme, type Theme } from "../model/theme.js";
import { themeBackground, themeDim, themeForeground } from "../model/theme-style.js";

type PreviewImage = ComposerDraftAttachment | DisplayImageAttachment;

function normalizedImage(input: PreviewImage): DisplayImageAttachment {
  if ("attachment" in input) return { ...input.attachment, label: input.label };
  return input;
}

export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatName(mediaType: string): string {
  return mediaType.slice("image/".length).replace("jpeg", "JPEG").toUpperCase();
}

export function imageDetailLine(input: PreviewImage): string {
  const image = normalizedImage(input);
  const dimensions = getImageDimensions(image.base64, image.mediaType);
  return [
    formatName(image.mediaType),
    dimensions ? `${dimensions.widthPx}×${dimensions.heightPx}` : undefined,
    formatImageBytes(image.bytes),
  ].filter(Boolean).join(" · ");
}

/** Grok-style transient preview rendered directly above the composer. */
export class ComposerImagePreviewComponent implements Component {
  private cachedKey?: string;
  private cachedImage?: Image;

  constructor(
    private readonly getImage: () => ComposerDraftAttachment | undefined,
    private readonly getTheme: () => Theme = () => darkTheme,
  ) {}

  render(width: number): string[] {
    const input = this.getImage();
    if (!input || width < 8) return [];
    const theme = this.getTheme();
    const image = normalizedImage(input);
    const innerWidth = Math.max(1, width - 4);
    const key = `${image.label}:${image.dataUrl.length}:${image.sourcePath ?? image.filename ?? ""}`;
    if (key !== this.cachedKey) {
      this.cachedKey = key;
      this.cachedImage = new Image(
        image.base64,
        image.mediaType,
        { fallbackColor: (text) => themeDim(theme.dim, text) },
        {
          maxWidthCells: Math.min(42, innerWidth),
          maxHeightCells: 6,
          filename: image.sourcePath ?? image.filename,
        },
      );
    }

    const header = truncateToWidth(`  ${chalk.bold(themeForeground(theme.inputText, image.label))}  ${themeDim(theme.dim, imageDetailLine(image))}`, width, "");
    const rows = [themeBackground(theme.backgroundPanel, `${header}${" ".repeat(Math.max(0, width - visibleWidth(header)))}`)];
    if (getCapabilities().images) rows.push(...(this.cachedImage?.render(innerWidth) ?? []));
    const path = image.sourcePath ?? image.filename;
    if (path) rows.push(truncateToWidth(themeDim(theme.dim, `  ${path}`), width));
    rows.push(truncateToWidth(themeDim(theme.dim, "  Enter to view · Backspace/Delete to remove"), width));
    return rows;
  }

  invalidate(): void {
    this.cachedKey = undefined;
    this.cachedImage?.invalidate();
  }
}

/** Full image inspector used by composer activation and sent-message clicks. */
export class ImageViewerComponent implements Component {
  focused = false;
  private readonly image: DisplayImageAttachment;
  private readonly renderer: Image;
  private hovered = false;

  constructor(
    input: PreviewImage,
    private readonly onClose: () => void,
    getTerminalRows: () => number = () => 30,
    private readonly getTheme: () => Theme = () => darkTheme,
  ) {
    this.image = normalizedImage(input);
    this.renderer = new Image(
      this.image.base64,
      this.image.mediaType,
      { fallbackColor: (text) => themeDim(this.getTheme().dim, text) },
      {
        maxWidthCells: 100,
        maxHeightCells: Math.max(1, Math.min(18, getTerminalRows() - 12)),
        filename: this.image.sourcePath ?? this.image.filename,
      },
    );
  }

  render(width: number): string[] {
    const theme = this.getTheme();
    const safeWidth = Math.max(1, width);
    if (safeWidth < 4) return [truncateToWidth(this.image.label, safeWidth, "")];
    const title = `${this.image.label}  ${imageDetailLine(this.image)}`;
    const titleRow = truncateToWidth(chalk.bold(themeForeground(theme.inputText, title)), Math.max(1, safeWidth - 4), "");
    const body = this.renderer.render(Math.max(1, safeWidth - 4));
    const path = this.image.sourcePath ?? this.image.filename;
    return [
      themeForeground(theme.border, `┌${"─".repeat(Math.max(0, safeWidth - 2))}┐`),
      `${themeForeground(theme.border, "│")} ${titleRow}${" ".repeat(Math.max(0, safeWidth - 4 - visibleWidth(titleRow)))} ${themeForeground(theme.border, "│")}`,
      ...body,
      ...(path ? [truncateToWidth(themeDim(theme.dim, `  ${path}`), safeWidth)] : []),
      truncateToWidth(themeDim(theme.dim, `  Esc close${this.hovered ? "  ·  click to close" : ""}`), safeWidth),
      themeForeground(theme.border, `└${"─".repeat(Math.max(0, safeWidth - 2))}┘`),
    ];
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q" || data === "\r") this.onClose();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") {
      const changed = this.hovered;
      this.hovered = false;
      return changed;
    }
    if (event.kind === "move") {
      const changed = !this.hovered;
      this.hovered = true;
      return changed;
    }
    if (!event.release && (event.button & 3) === 0) {
      this.onClose();
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.renderer.invalidate();
  }
}
