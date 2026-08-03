import type { AssistantProviderMetadata } from "../types.js";

const INTERNAL_TAG_PREFIX = "<bubble_internal_";
const MEMORY_CITATION_TAG = "<oai-mem-citation";
const INTERNAL_TAG_NAMES = ["reminder", "context"] as const;
const LEGACY_RUNTIME_MARKERS = [
  "Runtime reminder:\n",
  "Runtime context:\n",
];
const STREAM_MARKERS = [
  INTERNAL_TAG_PREFIX,
  MEMORY_CITATION_TAG,
  ...LEGACY_RUNTIME_MARKERS,
];

const LEGACY_REMINDER_END_PHRASES = [
  "Debugging workflow: find the failing boundary.",
  "Code explanation workflow: answer directly.",
  "Verify the specific failure path after the change.",
  "Run a narrow verification command or explain why it cannot be run.",
  "Keep summaries secondary to findings.",
  "Avoid proposing changes unless the user asks for them.",
  "Keep the first pass read-only unless the user asks for changes or runtime verification.",
  "Avoid drifting into code changes unless the user explicitly asks to execute.",
  "On rejection, remain in plan mode and iterate.",
  "Do not perform destructive operations, credential exposure, or unrelated reversions just because approvals are bypassed.",
  "Execute the requested change end to end; do not stop at analysis unless blocked or the user explicitly asks for discussion only.",
  "If current evidence is sufficient, summarize your findings now.",
  "- If you cannot determine the cause, ask the user for clarification.",
  "- Skip the \"investigate the codebase\" step that applies to larger changes.",
  "Do not put the final answer only in hidden reasoning.",
];

/** Prefix shared by every internal reminder/context block this module emits. */
export const INTERNAL_BLOCK_PREFIX = "<bubble_internal_";

/**
 * True when the text is an internal reminder/context block (e.g. a meta
 * message that the projector re-rolled into user role) rather than something
 * the user actually typed.
 */
export function isInternalBlockContent(text: string): boolean {
  return text.trimStart().startsWith(INTERNAL_BLOCK_PREFIX);
}

/**
 * True when the ENTIRE content is one internal block (start- and end-anchored)
 * — the shape harness-injected user-role messages (goal kicks, task wakes)
 * have. Display surfaces drop these rows outright; anything looser (a block
 * plus trailing text) must instead be sanitized, never dropped.
 */
export function isInternalBlockOnlyContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  return /^<bubble_internal_(?:context|reminder)\b/.test(trimmed)
    && /<\/bubble_internal_(?:context|reminder)>$/.test(trimmed);
}

export function formatInternalReminderBlock(kind: string, content: string): string {
  return formatInternalBlock("reminder", kind, content);
}

export function formatInternalContextBlock(kind: string, content: string): string {
  return formatInternalBlock("context", kind, content);
}

export function sanitizeInternalReminderBlocks(text: string): string {
  if (!text) return text;
  const sanitizer = createStreamingInternalReminderSanitizer();
  return sanitizer.push(text) + sanitizer.flush();
}

export function sanitizeInternalReasoningText(text: string): string {
  const withoutBlocks = sanitizeInternalReminderBlocks(text);
  if (!withoutBlocks) return withoutBlocks;
  return withoutBlocks
    .split(/\n{2,}/)
    .filter((paragraph) => !containsInternalReminderReference(paragraph))
    .join("\n\n");
}

export function sanitizeAssistantProviderMetadata(
  metadata: AssistantProviderMetadata | undefined,
): AssistantProviderMetadata | undefined {
  const anthropic = metadata?.anthropic;
  const blocks = anthropic?.contentBlocks;
  if (!metadata || !anthropic || !blocks?.length) return metadata;

  let changed = false;
  const sanitizedBlocks: typeof blocks = [];
  for (const block of blocks) {
    // Plaintext text blocks are unsigned, so rewriting them in place is safe.
    if (block.type === "text" && typeof block.text === "string") {
      const sanitizedText = sanitizeInternalReminderBlocks(block.text);
      if (sanitizedText !== block.text) {
        changed = true;
        sanitizedBlocks.push({ ...block, text: sanitizedText });
      } else {
        sanitizedBlocks.push(block);
      }
      continue;
    }

    // Extended-thinking blocks carry an Anthropic signature over their exact
    // text; rewriting the text would invalidate the signature and the API
    // would reject the replayed block. So when a thinking block's text carries
    // internal markup (e.g. an echoed system reminder), DROP the whole block
    // rather than mutate it. Thinking text is never user-visible — the display
    // path renders message.reasoning, not contentBlocks — so dropping loses
    // nothing on screen; it only keeps the verbatim reminder out of the
    // persisted metadata and the Anthropic replay payload. redacted_thinking
    // holds encrypted `data` (no plaintext field) and cannot carry a reminder.
    if (block.type === "thinking" && typeof block.thinking === "string") {
      if (sanitizeInternalReminderBlocks(block.thinking) !== block.thinking) {
        changed = true;
        continue;
      }
    }

    sanitizedBlocks.push(block);
  }

  if (!changed) return metadata;
  return {
    ...metadata,
    anthropic: {
      ...anthropic,
      contentBlocks: sanitizedBlocks,
    },
  };
}

export function createStreamingInternalReminderSanitizer() {
  let pending = "";

  const drain = (final: boolean): string => {
    let out = "";

    while (pending.length > 0) {
      const block = consumeInternalBlockAtStart(pending, final);
      if (block?.hold) break;
      if (block?.consume !== undefined) {
        pending = pending.slice(block.consume);
        continue;
      }

      const markerIndex = findEarliestCompleteMarker(pending);
      if (markerIndex >= 0) {
        if (markerIndex > 0) {
          out += pending.slice(0, markerIndex);
          pending = pending.slice(markerIndex);
          continue;
        }
        // A marker is present but the block is not yet complete enough to
        // consume. Hold it in streaming mode; drop it on final flush.
        if (final) {
          pending = "";
        }
        break;
      }

      if (!final) {
        const partialIndex = findEarliestMarkerPrefixSuffix(pending);
        if (partialIndex >= 0) {
          out += pending.slice(0, partialIndex);
          pending = pending.slice(partialIndex);
          break;
        }
      }

      out += pending;
      pending = "";
    }

    return out;
  };

  return {
    push(delta: string): string {
      if (!delta) return "";
      pending += delta;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}

function formatInternalBlock(type: "reminder" | "context", kind: string, content: string): string {
  const safeKind = kind.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `<bubble_internal_${type} kind="${safeKind}">\n${content}\n</bubble_internal_${type}>`;
}

function containsInternalReminderReference(text: string): boolean {
  return INTERNAL_REASONING_REFERENCE_PATTERNS.some((pattern) => pattern.test(text));
}

const INTERNAL_REASONING_REFERENCE_PATTERNS = [
  /<bubble_internal_(?:reminder|context)\b/i,
  /\bsystem\s+reminder\b/i,
  /\bruntime\s+reminder\b/i,
  /\bsystem\s+prompt\b/i,
  /The following deferred tools are available via tool_search/i,
  /Known deferred tools/i,
  /\bdeferred tools\b/i,
  /\bmcp__[a-z0-9_]+/i,
  /\bMCP\s+arxiv\s+tools\b/i,
  /\barxiv\s+MCP\s+tools\b/i,
  /Subagent lifecycle truth/i,
  /Count unique agent_id values only/i,
  /Do not describe a subagent as running or still working/i,
  /Background task truth/i,
  /Never re-run work a finished task already did/i,
  /Large-change checkpoint/i,
  /delegation only adds merge risk/i,
];

function consumeInternalBlockAtStart(text: string, final: boolean): { consume?: number; hold?: boolean } | undefined {
  if (text.startsWith(INTERNAL_TAG_PREFIX)) {
    return consumeStructuredInternalBlock(text, final);
  }

  if (text.startsWith(MEMORY_CITATION_TAG)) {
    return consumeMemoryCitationBlock(text, final);
  }

  if (text.startsWith("Runtime reminder:\n")) {
    return consumeLegacyRuntimeReminder(text, final);
  }

  if (text.startsWith("Runtime context:\n")) {
    return final ? { consume: text.length } : { hold: true };
  }

  return undefined;
}

function consumeMemoryCitationBlock(text: string, final: boolean): { consume?: number; hold?: boolean } | undefined {
  const openMatch = text.match(/^<oai-mem-citation\b[^>]*>/);
  if (!openMatch) {
    return isPrefixOf(MEMORY_CITATION_TAG, text)
      ? final ? { consume: text.length } : { hold: true }
      : undefined;
  }

  const closeTag = "</oai-mem-citation>";
  const closeIndex = text.indexOf(closeTag, openMatch[0].length);
  if (closeIndex < 0) {
    return final ? { consume: text.length } : { hold: true };
  }

  return { consume: consumeTrailingLineBreaks(text, closeIndex + closeTag.length) };
}

function consumeStructuredInternalBlock(text: string, final: boolean): { consume?: number; hold?: boolean } | undefined {
  for (const tagName of INTERNAL_TAG_NAMES) {
    const openMatch = text.match(new RegExp(`^<bubble_internal_${tagName}\\b[^>]*>`));
    if (!openMatch) continue;

    const closeTag = `</bubble_internal_${tagName}>`;
    const closeIndex = text.indexOf(closeTag, openMatch[0].length);
    if (closeIndex < 0) {
      return final ? { consume: text.length } : { hold: true };
    }

    return { consume: consumeTrailingLineBreaks(text, closeIndex + closeTag.length) };
  }

  if (isPrefixOf(INTERNAL_TAG_PREFIX, text)) {
    return final ? { consume: text.length } : { hold: true };
  }

  return undefined;
}

function consumeLegacyRuntimeReminder(text: string, final: boolean): { consume?: number; hold?: boolean } {
  for (const phrase of LEGACY_REMINDER_END_PHRASES) {
    const endIndex = text.indexOf(phrase, LEGACY_RUNTIME_MARKERS[0].length);
    if (endIndex >= 0) {
      return { consume: consumeTrailingLineBreaks(text, endIndex + phrase.length) };
    }
  }

  if (final) {
    return { consume: text.length };
  }

  return { hold: true };
}

function consumeTrailingLineBreaks(text: string, index: number): number {
  let next = index;
  while (text[next] === "\n") next += 1;
  return next;
}

function findEarliestCompleteMarker(text: string): number {
  let earliest = -1;
  for (const marker of STREAM_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0 && (earliest < 0 || index < earliest)) {
      earliest = index;
    }
  }
  return earliest;
}

function findEarliestMarkerPrefixSuffix(text: string): number {
  let earliest = -1;
  for (const marker of STREAM_MARKERS) {
    const max = Math.min(marker.length - 1, text.length);
    for (let length = max; length > 0; length -= 1) {
      const suffix = text.slice(text.length - length);
      if (isPrefixOf(marker, suffix)) {
        const index = text.length - length;
        if (earliest < 0 || index < earliest) {
          earliest = index;
        }
        break;
      }
    }
  }
  return earliest;
}

function isPrefixOf(value: string, possiblePrefix: string): boolean {
  return value.startsWith(possiblePrefix);
}
