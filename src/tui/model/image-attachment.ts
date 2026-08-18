/** Image attachment shape (moved from src/tui-ink/image-paste.ts at cutover). */
export interface ImageAttachment {
  base64: string;
  mediaType: string;
  /** Raw byte size of the decoded image (not base64). */
  bytes: number;
  /** data:<mediaType>;base64,<...> — ready to send as image_url.url. */
  dataUrl: string;
  filename?: string;
  sourcePath?: string;
}
