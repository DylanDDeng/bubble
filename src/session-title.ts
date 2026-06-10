import type { SessionManager, SessionLogEntry } from "./session.js";
import { normalizeSingleLine, truncateVisual } from "./text-display.js";
import { createPastedContentMarker, shouldCollapsePastedContent } from "./tui/paste-placeholder.js";
import type { ContentPart, Message, ProviderMessage, ThinkingLevel } from "./types.js";

const TITLE_INPUT_MAX_CHARS = 4000;
const TITLE_MAX_WIDTH = 80;

const TITLE_SYSTEM_PROMPT = [
  "You are a title generator. Output ONLY a conversation title.",
  "",
  "Rules:",
  "- Single line only.",
  "- Use the same language as the user message.",
  "- Keep it brief and useful for finding this conversation later.",
  "- Do not answer the user's request.",
  "- Do not mention tools unless the tool itself is the topic.",
  "- No explanations, no markdown, no quotes.",
].join("\n");

export interface SessionTitleUpdater {
  handlePersistedMessage(message: Message): void;
}

export function createSessionTitleUpdater(options: {
  sessionManager: SessionManager;
  complete: (
    messages: ProviderMessage[],
    options?: { model?: string; temperature?: number; thinkingLevel?: ThinkingLevel; abortSignal?: AbortSignal },
  ) => Promise<string>;
}): SessionTitleUpdater {
  let pending: TitleCandidate | undefined;
  let inFlight = false;

  const run = async (candidate: TitleCandidate) => {
    const raw = await options.complete(buildTitleMessages(candidate.input), {
      temperature: 0.3,
      thinkingLevel: "off",
    });
    const title = cleanGeneratedTitle(raw);
    if (!title) return;
    if (!isCandidateCurrent(options.sessionManager.getEntries(), candidate.userMessageId)) return;
    if (options.sessionManager.getMetadata().title?.trim()) return;
    options.sessionManager.updateMetadata({
      title,
      titleSource: "llm",
      titleUpdatedAt: Date.now(),
      titleUserMessageId: candidate.userMessageId,
    });
  };

  return {
    handlePersistedMessage(message: Message) {
      if (message.role === "user") {
        if (pending || inFlight) return;
        if (options.sessionManager.getMetadata().title?.trim()) return;
        if (currentUserMessageCount(options.sessionManager.getMessages()) !== 1) return;
        const userEntryId = latestUserMessageEntryId(options.sessionManager.getEntries());
        if (!userEntryId) return;
        const input = titleInputFromUserContent(message.content);
        if (!input) return;
        pending = { input, userMessageId: userEntryId };
        return;
      }

      if (message.role !== "assistant" || !pending || inFlight) return;
      const candidate = pending;
      pending = undefined;
      inFlight = true;
      void run(candidate).catch(() => undefined).finally(() => {
        inFlight = false;
      });
    },
  };
}

export function cleanGeneratedTitle(raw: string): string {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const withoutFences = withoutThinking.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "");
  const line = withoutFences
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return "";
  const unquoted = line.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  return truncateVisual(normalizeSingleLine(unquoted), TITLE_MAX_WIDTH);
}

export function deterministicTitleFromUserContent(content: string | ContentPart[]): string {
  const text = userContentText(content);
  if (!text) return "User message";
  if (shouldCollapsePastedContent(text)) {
    return createPastedContentMarker(text);
  }
  return truncateVisual(normalizeSingleLine(text), TITLE_MAX_WIDTH) || "User message";
}

function titleInputFromUserContent(content: string | ContentPart[]): string {
  const title = deterministicTitleFromUserContent(content);
  const text = userContentText(content);
  if (!text) return title;
  return normalizeSingleLine(text).slice(0, TITLE_INPUT_MAX_CHARS);
}

function userContentText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  const text = content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
  if (text.trim()) return text;
  return content.some((part) => part.type === "image_url") ? "Image attachment" : "";
}

function buildTitleMessages(input: string): ProviderMessage[] {
  return [
    { role: "system", content: TITLE_SYSTEM_PROMPT },
    { role: "user", content: `Generate a title for this conversation:\n\n${input}` },
  ];
}

function currentUserMessageCount(messages: Message[]): number {
  return messages.filter((message) => message.role === "user").length;
}

function latestUserMessageEntryId(entries: SessionLogEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "user_message") return entry.id;
  }
  return undefined;
}

function isCandidateCurrent(entries: SessionLogEntry[], userMessageId: string): boolean {
  let clearIndex = -1;
  let userIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "marker" && entry.kind === "conversation_clear") clearIndex = i;
    if (entry.id === userMessageId) userIndex = i;
  }
  return userIndex > clearIndex;
}

interface TitleCandidate {
  input: string;
  userMessageId: string;
}
