// Models with non-OpenAI chat templates (GLM-4.5/4.6, DeepSeek, some Kimi builds)
// emit tool-call delimiters as inline assistant text instead of as structured
// tool_calls deltas. The shapes vary — `<|tool_call|>`, `<｜｜DSML｜｜tool_calls>`,
// `<｜｜DSML｜｜invoke name="x">`, closing `</｜｜DSML｜｜tool_calls>`, etc. — but
// they always share the pattern of a tag whose name is wrapped in `|` or `｜`.
// If we let any of that text reach the consumer it pollutes the streamed
// assistant text and, downstream, the subagent's summary field.

const TOOL_PROTOCOL_PATTERNS: RegExp[] = [
  // Generic: opening or closing tag whose name is wrapped in `|` or `｜`,
  // optionally with attributes after the closing pipe (e.g. `invoke name="x"`).
  /<\/?\s*[｜|]+[^<>]*?[｜|]+[^<>]*>/g,
  // Plain ASCII variants without attributes.
  /<\/?\|tool_calls?\|>/gi,
];

export function stripProviderProtocolArtifacts(text: string): string {
  let out = text;
  for (const pattern of TOOL_PROTOCOL_PATTERNS) {
    out = out.replace(pattern, "");
  }
  return out;
}

export function isOnlyProviderProtocolArtifacts(text: string): boolean {
  return !!text.trim() && stripProviderProtocolArtifacts(text).trim().length === 0;
}

export interface ProviderProtocolArtifactFilter {
  push(text: string): string;
  flush(): string;
}

export function createProviderProtocolArtifactFilter(): ProviderProtocolArtifactFilter {
  let pending = "";
  return {
    push(text: string): string {
      pending = stripProviderProtocolArtifacts(pending + text);
      const keep = trailingPossibleMarkerLength(pending);
      const emit = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      return emit;
    },
    flush(): string {
      const out = stripProviderProtocolArtifacts(pending);
      pending = "";
      return out;
    },
  };
}

// Hold back a trailing fragment if it could be the start of a pipe-wrapped tag
// whose closing `>` hasn't arrived yet. Without this guard, a stream that flushes
// mid-tag (`<` ... `｜DSML｜tool_calls`) would emit the partial tag as text, then
// emit the rest later — the stripping regex only matches complete tags.
function trailingPossibleMarkerLength(text: string): number {
  const lastLt = text.lastIndexOf("<");
  if (lastLt === -1) return 0;
  const tail = text.slice(lastLt);
  if (tail.includes(">")) return 0;
  // Hold back only when the trailing fragment looks like the start of a protocol
  // tag. Anything else (e.g. `if (x < y)` in source) flushes immediately.
  if (/^<\/?$/.test(tail)) return tail.length;
  if (/^<\/?\s*[｜|]/.test(tail)) return tail.length;
  return 0;
}
