/** Claude thinking bound to both the model and the exact preceding conversation.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */
export function isClaudeWithBoundThinking(model?: string): boolean {
  const match = model?.match(/(?:^|:)claude-(opus|fable)-(\d+)(?:-(\d{1,2})(?=-|\[|$))?/i);
  if (!match) return false;
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  return major > 5 || (major === 5 && minor >= (match[1].toLowerCase() === "opus" ? 5 : 1));
}
