import type { TraceGroup } from "./trace-groups.js";

export type TraceRowTarget =
  | { kind: "group"; key: string; groupKey: string; foldable: boolean }
  | { kind: "item"; key: string; groupKey: string; toolId: string; foldable: boolean };

/**
 * UI-only fold/selection state. Tool lifecycle data remains immutable in the
 * controller; live and settled renderers share this object so committing a
 * turn cannot reset an expanded tool entry.
 */
export class TraceInteractionState {
  private revision = 0;
  private selectedKey?: string;
  private selectedGroupKey?: string;
  private hoveredGroupKey?: string;
  private readonly expandedGroups = new Set<string>();
  private readonly expandedItems = new Set<string>();

  groupKey(group: TraceGroup): string {
    return `${group.kind}:${group.raw[0]?.id ?? group.title}`;
  }

  itemKey(group: TraceGroup, toolId: string): string {
    return `${this.groupKey(group)}:item:${toolId}`;
  }

  isSelected(key: string): boolean {
    return this.selectedKey === key;
  }

  isGroupSelected(groupKey: string): boolean {
    return this.selectedGroupKey === groupKey;
  }

  isGroupHovered(groupKey: string): boolean {
    return this.hoveredGroupKey === groupKey;
  }

  isGroupExpanded(groupKey: string): boolean {
    return this.expandedGroups.has(groupKey);
  }

  isItemExpanded(itemKey: string): boolean {
    return this.expandedItems.has(itemKey);
  }

  /**
   * Monotonic render revision for transcript projection caches. The tool
   * lifecycle remains immutable in the controller; only these UI affordances
   * can change the settled projection without replacing the transcript array.
   */
  getRevision(): number {
    return this.revision;
  }

  activate(target: TraceRowTarget, clickCount: 1 | 2): void {
    const selectionChanged = this.selectedKey !== target.key || this.selectedGroupKey !== target.groupKey;
    this.selectedKey = target.key;
    this.selectedGroupKey = target.groupKey;
    let foldChanged = false;
    if (clickCount !== 2 || !target.foldable) {
      if (selectionChanged) this.revision += 1;
      return;
    }
    if (target.kind === "group") {
      this.toggle(this.expandedGroups, target.groupKey);
      foldChanged = true;
    } else {
      this.toggle(this.expandedItems, target.key);
      foldChanged = true;
    }
    if (selectionChanged || foldChanged) this.revision += 1;
  }

  hover(target: TraceRowTarget | undefined): boolean {
    const next = target?.groupKey;
    if (next === this.hoveredGroupKey) return false;
    this.hoveredGroupKey = next;
    this.revision += 1;
    return true;
  }

  clearHover(): boolean {
    return this.hover(undefined);
  }

  private toggle(values: Set<string>, key: string): void {
    if (values.has(key)) values.delete(key);
    else values.add(key);
  }
}
