import type { SessionMetadata } from "../session.js";
import { normalizeSingleLine, truncateVisual } from "../text-display.js";

const SESSION_DISPLAY_TITLE_MAX_WIDTH = 80;

export interface SessionDisplaySource {
  getMetadata(): SessionMetadata;
  getSessionFile(): string;
}

export function sessionDisplayName(sessionManager?: SessionDisplaySource) {
  if (!sessionManager) return "Session";
  const title = truncateVisual(
    normalizeSingleLine(sessionManager.getMetadata().title ?? ""),
    SESSION_DISPLAY_TITLE_MAX_WIDTH,
  );
  if (title) return title;

  const file = sessionManager.getSessionFile();
  const name = file.split(/[\\/]/).pop() || "Session";
  return name.replace(/\.jsonl$/, "");
}
