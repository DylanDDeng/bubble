/*
 * Pure mappers from coworker composer selections to Bubble agent settings.
 * No core/electron imports so they can be unit-tested headlessly.
 */

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** coworker AegisPermissionMode -> Bubble PermissionMode */
export function permissionModeToBubble(mode: string | undefined): 'default' | 'plan' | 'bypassPermissions' {
  switch (mode) {
    case 'readOnly':
      return 'plan';
    case 'fullAccess':
      return 'bypassPermissions';
    case 'defaultPermissions':
    default:
      return 'default';
  }
}

/** Reasoning effort from the composer -> Bubble ThinkingLevel (or undefined to use default). */
export function reasoningToThinking(effort: string | undefined): (typeof THINKING_LEVELS)[number] | undefined {
  if (!effort) return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(effort)
    ? (effort as (typeof THINKING_LEVELS)[number])
    : undefined;
}
