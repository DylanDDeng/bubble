import type { BrowserWindow } from 'electron';
import type { ServerEvent } from '../../shared/types';

/** A failed display must not throw back into a provider's streaming callback. */
export function sendRendererEvent(win: BrowserWindow, event: ServerEvent): void {
  if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  try {
    win.webContents.send('server-event', JSON.stringify(event));
  } catch {
    // The render frame can disappear between the liveness check and send.
    // Completed messages remain in the host's history and hydrate on reload.
    console.warn('[Renderer Delivery] Could not deliver event', event.type);
  }
}
