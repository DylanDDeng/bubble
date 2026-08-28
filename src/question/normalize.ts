/**
 * Structured-question fields are rendered as single terminal rows. Models can
 * still return embedded CR/LF/tab whitespace, so collapse it at the question
 * boundary instead of letting terminal control characters reach a renderer.
 */
export function normalizeQuestionInlineText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?，。；：！？、）)\]}])/gu, "$1")
    .trim();
}
