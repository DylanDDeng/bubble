/**
 * Tracks overlapping paste operations by identity. Finishing an older paste
 * must never clear the pending state of a newer paste.
 */
export class PasteOperationTracker {
  private nextId = 1;
  private readonly active = new Set<number>();

  begin(): number {
    const id = this.nextId++;
    this.active.add(id);
    return id;
  }

  finish(id: number): void {
    this.active.delete(id);
  }

  invalidateAll(): void {
    this.active.clear();
  }

  get hasPending(): boolean {
    return this.active.size > 0;
  }

  get pendingCount(): number {
    return this.active.size;
  }
}
