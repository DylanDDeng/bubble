/**
 * Extract user-visible signals from a partial tool-call JSON buffer.
 *
 * We deliberately do NOT attempt a full partial-JSON parse. The goal is just
 * to surface the file path (so the tool header can render) and a coarse
 * "how much has been streamed" hint, both available the moment the model has
 * emitted enough text for them to be unambiguous.
 */

const PATH_FIELDS = ["path", "file_path", "filePath"] as const;

export interface StreamingArgsHint {
  /** First fully-closed string value found for a known path field. */
  path?: string;
  /** Count of escaped newline sequences (`\n`) seen so far — proxy for written line count. */
  newlineCount: number;
}

export function extractStreamingArgsHint(raw: string): StreamingArgsHint {
  let path: string | undefined;
  for (const field of PATH_FIELDS) {
    const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const m = raw.match(re);
    if (m) {
      try {
        path = JSON.parse(`"${m[1]}"`);
        break;
      } catch {
        // The matched substring ended mid-escape; ignore and wait for more.
      }
    }
  }
  const newlines = raw.match(/\\n/g);
  return {
    path,
    newlineCount: newlines ? newlines.length : 0,
  };
}
