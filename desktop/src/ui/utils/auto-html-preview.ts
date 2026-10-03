import { HtmlPreviewError, openHtmlFileInBrowserTab } from './html-preview';

/** Auto-preview is a one-shot convenience, not a retry queue. Manual opens
 * still report path errors normally and can be retried explicitly. */
export async function autoPreviewHtmlArtifact({
  sessionId, cwd, filePath, toolUseId, pending, attempted, isCurrent, onOpened, onError,
}: {
  sessionId: string;
  cwd: string;
  filePath: string;
  toolUseId: string;
  pending: Set<string>;
  attempted: Set<string>;
  isCurrent: () => boolean;
  onOpened: () => void;
  onError: (error: unknown) => void;
}): Promise<void> {
  // Consume before awaiting IPC. Session switches, failures and a newer turn
  // must neither resubmit this attempt nor have their pending state cleared
  // later by an old promise.
  pending.delete(sessionId);
  const key = `${sessionId}:${toolUseId}`;
  if (attempted.has(key)) return;
  attempted.add(key);
  try {
    await openHtmlFileInBrowserTab({ sessionId, cwd, filePath });
    if (isCurrent()) onOpened();
  } catch (error) {
    // Temp/out-of-project artifacts are legitimate tool outputs, but are not
    // eligible for automatic project previews. Keep the main-process guard.
    if (error instanceof HtmlPreviewError && error.code === 'outside_project') return;
    if (isCurrent()) onError(error);
  }
}
