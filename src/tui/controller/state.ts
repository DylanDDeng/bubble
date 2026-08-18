/**
 * Mutable container for all controller-owned state. Single-writer: only the
 * controller mutates; readers get immutable snapshots (snapshot.ts).
 * `withTransaction` batches mutations into one snapshot + one notification.
 */

export class ControllerState {
  private transactionDepth = 0;
  private dirty = false;

  /** Bump on every committed change; consumers use it for cache invalidation. */
  version = 0;

  withTransaction<T>(fn: () => T): T {
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0 && this.dirty) {
        this.dirty = false;
        this.version += 1;
      }
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      throw error;
    }
  }

  /** Mark mutated; version advances when the outermost transaction exits. */
  touch(): void {
    if (this.transactionDepth > 0) {
      this.dirty = true;
    } else {
      this.version += 1;
    }
  }
}
