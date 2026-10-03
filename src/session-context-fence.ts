import type { SessionManager } from "./session.js";

/** The revision of a host's resident history, not the manager's refreshed log.
 * Reads and audit/metadata refreshes never legitimize a foreign conversation.
 * Local clear/rewind/manual compaction replace history explicitly; other local
 * writes advance the fence only when they extend the host's existing snapshot.
 */
export class SessionContextFence {
  private revision: string;
  private readonly unsubscribe: () => void;

  constructor(private readonly session: SessionManager) {
    this.revision = session.getRevision();
    this.unsubscribe = session.subscribeContextCommits((previous, revision, replacement) => {
      if (replacement || previous === this.revision) this.revision = revision;
    });
  }

  getRevision(): string { return this.revision; }

  /** Call only alongside replacing the host's resident messages. */
  reloadHistory() {
    const messages = this.session.getMessages();
    this.revision = this.session.getRevision();
    return messages;
  }

  dispose(): void { this.unsubscribe(); }
}
