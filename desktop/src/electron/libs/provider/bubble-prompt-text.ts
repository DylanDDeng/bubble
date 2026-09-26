import type { Attachment } from '../../../shared/types';

/**
 * Placeholder that older sessions stored in place of a long prompt after the
 * composer moved it into a pasted-text attachment. The composer no longer does
 * this; the constant only exists so replayed history never shows it to the model.
 */
export const LONG_PROMPT_ATTACHMENT_INSTRUCTION =
  'The main request is attached as a text file. Read the attachment first, then respond normally.';

function isPastedText(attachment: Attachment): attachment is Attachment & { previewText: string } {
  return attachment.uiType === 'pasted_text' && !!attachment.previewText?.trim();
}

/**
 * Builds the text the Bubble agent receives for one user send.
 *
 * Pasted-text attachments (legacy, from sessions recorded before the composer
 * stopped folding long pastes into chips) are the user's own words, so they go
 * inline ahead of the typed text and never by path. Only real on-disk files
 * are listed by path.
 */
export function buildPromptText(prompt: string, attachments: Attachment[] | undefined): string {
  const fileAttachments = attachments?.filter((attachment) => attachment.kind !== 'image') || [];
  const pasted = fileAttachments.filter(isPastedText);
  const files = fileAttachments.filter((attachment) => !isPastedText(attachment));

  const typed = prompt.trim();
  const body = pasted.length > 0 && typed === LONG_PROMPT_ATTACHMENT_INSTRUCTION ? '' : prompt;

  const sections: string[] = [];
  for (const attachment of pasted) sections.push(attachment.previewText.trim());
  if (body) sections.push(body);
  if (files.length > 0) {
    sections.push(['Attachments:', ...files.map((attachment) => `- ${attachment.name}: ${attachment.path}`)].join('\n'));
  }
  return sections.join('\n\n');
}
