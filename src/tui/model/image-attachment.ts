/** Image attachment shape shared by composer, provider payload, and history. */
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

/** Image state retained by a rendered user message after composer submit. */
export interface DisplayImageAttachment extends ImageAttachment {
  label: string;
}
