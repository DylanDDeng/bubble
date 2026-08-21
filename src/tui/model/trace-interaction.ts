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

  activate(target: TraceRowTarget, clickCount: 1 | 2): void {
    this.selectedKey = target.key;
    this.selectedGroupKey = target.groupKey;
    if (clickCount !== 2) return;
    if (!target.foldable) return;
    if (target.kind === "group") {
      this.toggle(this.expandedGroups, target.groupKey);
      return;
    }
    this.toggle(this.expandedItems, target.key);
  }

  hover(target: TraceRowTarget | undefined): boolean {
    const next = target?.groupKey;
    if (next === this.hoveredGroupKey) return false;
    this.hoveredGroupKey = next;
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
