import { homedir } from "node:os";
import { dirname } from "node:path";
import chalk from "chalk";
import {
  Input,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
} from "@bubblebrain-ai/pi-tui";
import type { SkillRegistry } from "../../skills/registry.js";
import type { SkillRecord } from "../../skills/types.js";
import { parseTerminalMouseWheel } from "../model/terminal-mouse.js";
import { darkTheme } from "../model/theme.js";

type SkillFilter = "all" | "enabled" | "disabled";
type SourceGroup = SkillRecord["source"];

const GROUP_ORDER: SourceGroup[] = ["project", "user", "configured"];
const GROUP_LABEL: Record<SourceGroup, string> = {
  project: "Project",
  user: "User",
  configured: "Config",
};
const MAX_PANEL_HEIGHT = 34;
const PANEL_BACKGROUND = "#1F1F1F";

interface SelectableEntry {
  key: string;
  kind: "group" | "skill";
  group: SourceGroup;
  skill?: SkillRecord;
}

interface RenderRow {
  text: string;
  key?: string;
  selectable?: SelectableEntry;
}

interface HitRow {
  kind: "entry" | "search" | "filter" | "footer-toggle" | "footer-reload";
  key?: string;
  start?: number;
  end?: number;
  row?: number;
}

interface ActionBadge {
  text: string;
  expiresAt: number;
}

export interface SkillsPanelComponentOptions {
  getTerminalRows(): number;
  onClose(): void;
  onRender(): void;
  onSkillsChanged(): void;
}

function fit(value: string, width: number, ellipsis = ""): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(value, width, ellipsis);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function alignSides(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (!right) return fit(left, width, "…");
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width * 0.48)));
  const clippedRight = truncateToWidth(right, rightWidth, "…");
  const gap = 2;
  const leftWidth = Math.max(0, width - visibleWidth(clippedRight) - gap);
  return `${fit(left, leftWidth, "…")}${" ".repeat(gap)}${clippedRight}`;
}

function friendlyPath(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function skillSourceLabel(skill: SkillRecord): string {
  return friendlyPath(dirname(skill.rootDir));
}

function sourceKey(source: SourceGroup): string {
  return `group:${source}`;
}

function skillKey(name: string): string {
  return `skill:${name}`;
}

function filterLabel(filter: SkillFilter): string {
  if (filter === "enabled") return "Enabled";
  if (filter === "disabled") return "Disabled";
  return "All";
}

function nextFilter(filter: SkillFilter): SkillFilter {
  if (filter === "all") return "enabled";
  if (filter === "enabled") return "disabled";
  return "all";
}

function matchesSkill(skill: SkillRecord, query: string): { matches: boolean; nameHit: boolean } {
  if (!query) return { matches: true, nameHit: true };
  const needle = query.toLocaleLowerCase();
  const nameHit = skill.meta.name.toLocaleLowerCase().includes(needle)
    || (skill.meta.author ?? "").toLocaleLowerCase().includes(needle);
  const descriptionHit = skill.meta.description.toLocaleLowerCase().includes(needle);
  const tagsHit = (skill.meta.tags ?? []).some((tag) => tag.toLocaleLowerCase().includes(needle));
  return { matches: nameHit || descriptionHit || tagsHit, nameHit };
}

/** Grok-style centered Skill browser/manager opened by /skills. */
export class SkillsPanelComponent implements Component, Focusable {
  focused = false;
  private readonly search = new Input({ prompt: "" });
  private searchActive = false;
  private filter: SkillFilter = "all";
  private selectedKey: string | undefined;
  private hoveredKey: string | undefined;
  private collapsedGroups = new Set<SourceGroup>();
  private expandedSkills = new Set<string>();
  private actionBadges = new Map<string, ActionBadge>();
  private offset = 0;
  private manuallyScrolled = false;
  private bodyRows = 0;
  private frameWidth = 0;
  private closeHovered = false;
  private filterHovered = false;
  private searchHovered = false;
  private hitRows: Array<HitRow | undefined> = [];
  private footerHits: HitRow[] = [];
  private selectableEntries: SelectableEntry[] = [];

  constructor(
    private readonly registry: SkillRegistry,
    private readonly options: SkillsPanelComponentOptions,
  ) {
    this.seedCollapsedGroups();
    this.search.onBackspaceAtStart = () => this.stopSearch();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(1, Math.floor(width));
    const frameHeight = Math.max(1, Math.min(MAX_PANEL_HEIGHT, this.options.getTerminalRows() - 6));
    this.frameWidth = frameWidth;
    if (frameWidth < 40 || frameHeight < 12) {
      return [truncateToWidth("Skills requires a 40 × 12 terminal · Esc close", frameWidth, "")]
        .slice(0, frameHeight);
    }

    this.pruneBadges();
    const innerWidth = frameWidth - 2;
    const horizontal = "─".repeat(innerWidth);
    const close = this.closeHovered ? chalk.bold.white("[✗]") : chalk.gray("[✗]");
    const topDashCount = Math.max(0, frameWidth - 7);
    const top = `${chalk.gray("┌")}${chalk.gray("─".repeat(topDashCount))} ${close} ${chalk.gray("┐")}`;
    const bottom = chalk.gray(`└${horizontal}┘`);
    const separator = chalk.gray(`├${horizontal}┤`);
    const tab = this.frameLine(`  ${chalk.bgHex(darkTheme.traceHoverBg).bold.white(" Skills ")}`, innerWidth);
    const search = this.frameLine(this.renderSearch(innerWidth), innerWidth);

    const footerRows = this.searchActive ? 0 : 2;
    this.bodyRows = Math.max(1, frameHeight - 5 - footerRows);
    const contentWidth = Math.max(1, innerWidth - 4);
    const rows = this.buildRows(contentWidth);
    this.selectableEntries = rows
      .map((row) => row.selectable)
      .filter((entry): entry is SelectableEntry => !!entry);
    this.ensureSelection();

    const selectedLine = rows.findIndex((row) => row.key === this.selectedKey);
    if (selectedLine >= 0 && !this.manuallyScrolled) {
      if (selectedLine < this.offset) this.offset = selectedLine;
      if (selectedLine >= this.offset + this.bodyRows) this.offset = selectedLine - this.bodyRows + 1;
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, rows.length - this.bodyRows)));

    this.hitRows = [];
    this.footerHits = [];
    const visible = rows.slice(this.offset, this.offset + this.bodyRows);
    while (visible.length < this.bodyRows) visible.push({ text: "" });
    const bodyStart = 4;
    const body = visible.map((row, index) => {
      const localY = bodyStart + index;
      if (row.selectable && row.key) this.hitRows[localY] = { kind: "entry", key: row.key };
      const selected = !!row.key && row.key === this.selectedKey && !this.searchActive;
      const hovered = !!row.key && row.key === this.hoveredKey;
      const content = `  ${fit(row.text, contentWidth, "…")}  `;
      const styled = selected
        ? chalk.bgHex(darkTheme.traceSelectedBg).bold.white(fit(content, innerWidth))
        : hovered
          ? chalk.bgHex(darkTheme.traceHoverBg).white(fit(content, innerWidth))
          : chalk.bgHex(PANEL_BACKGROUND)(fit(content, innerWidth));
      return `${chalk.gray("│")}${styled}${chalk.gray("│")}`;
    });

    const footer = this.searchActive ? [] : this.renderFooter(innerWidth, bodyStart + this.bodyRows);
    return [top, tab, search, separator, ...body, ...footer, bottom]
      .slice(0, frameHeight)
      .map((line) => truncateToWidth(line, frameWidth, ""));
  }

  handleInput(data: string): void {
    const wheel = parseTerminalMouseWheel(data);
    if (wheel.length > 0) {
      for (const direction of wheel) this.scroll(direction === "up" ? -3 : 3);
      return;
    }

    if (this.searchActive) {
      if (matchesKey(data, "escape")) return this.stopSearch();
      if (matchesKey(data, "up")) return this.moveSelection(-1);
      if (matchesKey(data, "down")) return this.moveSelection(1);
      if (matchesKey(data, "pageUp")) return this.moveSelection(-Math.max(1, this.bodyRows - 1));
      if (matchesKey(data, "pageDown")) return this.moveSelection(Math.max(1, this.bodyRows - 1));
      if (matchesKey(data, "enter")) return this.toggleExpanded();
      const before = this.search.getValue();
      this.search.focused = this.focused;
      this.search.handleInput(data);
      if (this.search.getValue() !== before) {
        this.selectedKey = undefined;
        this.offset = 0;
        this.manuallyScrolled = false;
      }
      this.options.onRender();
      return;
    }

    if (matchesKey(data, "escape")) return this.options.onClose();
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === "/") return this.startSearch();
    if (printable === "f") return this.cycleFilter();
    if (printable === "r") return this.reload();
    if (matchesKey(data, "space")) return this.toggleEnabled();
    if (matchesKey(data, "up") || printable === "k") return this.moveSelection(-1);
    if (matchesKey(data, "down") || printable === "j") return this.moveSelection(1);
    if (matchesKey(data, "pageUp")) return this.moveSelection(-Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "pageDown")) return this.moveSelection(Math.max(1, this.bodyRows - 1));
    if (matchesKey(data, "home")) return this.selectBoundary("first");
    if (matchesKey(data, "end") || printable === "G") return this.selectBoundary("last");
    if (matchesKey(data, "enter") || matchesKey(data, "right") || printable === "l") return this.toggleExpanded(false);
    if (matchesKey(data, "left") || printable === "h") return this.collapseSelected();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (event.kind === "leave") {
      const changed = this.closeHovered || this.filterHovered || this.searchHovered || this.hoveredKey !== undefined;
      this.closeHovered = false;
      this.filterHovered = false;
      this.searchHovered = false;
      this.hoveredKey = undefined;
      return changed;
    }

    const overClose = event.y === 0
      && event.x >= Math.max(0, this.frameWidth - 6)
      && event.x < this.frameWidth - 1;
    const hit = this.hitRows[event.y] ?? this.footerHits.find((candidate) => (
      event.y === candidate.row
      && event.x >= (candidate.start ?? 0)
      && event.x < (candidate.end ?? 0)
    ));
    const overSearch = event.y === 2 && event.x > 1 && event.x < this.frameWidth - 14;
    const overFilter = event.y === 2 && event.x >= Math.max(1, this.frameWidth - 14) && event.x < this.frameWidth - 1;
    const overEntryKey = hit?.kind === "entry" ? hit.key : undefined;

    if (event.kind === "move") {
      const changed = this.closeHovered !== overClose
        || this.searchHovered !== overSearch
        || this.filterHovered !== overFilter
        || this.hoveredKey !== overEntryKey;
      this.closeHovered = overClose;
      this.searchHovered = overSearch;
      this.filterHovered = overFilter;
      this.hoveredKey = overEntryKey;
      return changed;
    }
    if (event.release || (event.button & 3) !== 0) return false;
    if (overClose) {
      this.options.onClose();
      return true;
    }
    if (overSearch) {
      this.startSearch();
      return true;
    }
    if (overFilter || hit?.kind === "filter") {
      this.cycleFilter();
      return true;
    }
    if (hit?.kind === "footer-reload") {
      this.reload();
      return true;
    }
    if (hit?.kind === "footer-toggle") {
      this.toggleEnabled();
      return true;
    }
    if (hit?.kind === "entry" && hit.key) {
      this.selectedKey = hit.key;
      this.manuallyScrolled = false;
      this.toggleExpanded();
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.search.invalidate?.();
  }

  private frameLine(content: string, width: number): string {
    return `${chalk.gray("│")}${chalk.bgHex(PANEL_BACKGROUND)(fit(content, width))}${chalk.gray("│")}`;
  }

  private renderSearch(innerWidth: number): string {
    const filter = filterLabel(this.filter);
    const filterText = this.filterHovered || this.filter !== "all"
      ? chalk.bgHex(darkTheme.traceHoverBg).white(` f ${filter} `)
      : chalk.gray(` f ${filter} `);
    const filterWidth = visibleWidth(` f ${filter} `);
    const leftWidth = Math.max(1, innerWidth - filterWidth - 3);
    let left: string;
    if (this.searchActive) {
      this.search.focused = this.focused;
      left = this.search.render(leftWidth)[0] ?? "";
    } else {
      this.search.focused = false;
      left = this.searchHovered
        ? chalk.white("/ to search")
        : chalk.gray.dim("/ to search");
    }
    return fit(`  ${fit(left, leftWidth)} ${filterText}`, innerWidth);
  }

  private renderFooter(innerWidth: number, firstRow: number): string[] {
    const actionPlain = "space toggle  ·  f filter  ·  r reload  ·  / search";
    const navPlain = "↑/↓ navigate  ·  Enter expand  ·  Esc close";
    const actionLeft = Math.max(0, Math.floor((innerWidth - visibleWidth(actionPlain)) / 2));
    const navLeft = Math.max(0, Math.floor((innerWidth - visibleWidth(navPlain)) / 2));
    const action = fit(`${" ".repeat(actionLeft)}${chalk.dim(actionPlain)}`, innerWidth);
    const nav = fit(`${" ".repeat(navLeft)}${chalk.dim(navPlain)}`, innerWidth);
    const toggleAt = actionPlain.indexOf("space toggle");
    const filterAt = actionPlain.indexOf("f filter");
    const reloadAt = actionPlain.indexOf("r reload");
    this.footerHits = [
      { kind: "footer-toggle", start: 1 + actionLeft + toggleAt, end: 1 + actionLeft + toggleAt + "space toggle".length, row: firstRow },
      { kind: "filter", start: 1 + actionLeft + filterAt, end: 1 + actionLeft + filterAt + "f filter".length, row: firstRow },
      { kind: "footer-reload", start: 1 + actionLeft + reloadAt, end: 1 + actionLeft + reloadAt + "r reload".length, row: firstRow },
    ];
    return [this.frameLine(action, innerWidth), this.frameLine(nav, innerWidth)];
  }

  private buildRows(contentWidth: number): RenderRow[] {
    const query = this.search.getValue().trim().toLocaleLowerCase();
    const rows: RenderRow[] = [];
    const records = this.registry.all();

    for (const source of GROUP_ORDER) {
      const members = records
        .filter((skill) => skill.source === source)
        .filter((skill) => {
          const enabled = this.registry.isEnabled(skill.meta.name);
          if (this.filter === "enabled" && !enabled) return false;
          if (this.filter === "disabled" && enabled) return false;
          return matchesSkill(skill, query).matches;
        })
        .sort((a, b) => {
          const aMatch = matchesSkill(a, query);
          const bMatch = matchesSkill(b, query);
          if (aMatch.nameHit !== bMatch.nameHit) return aMatch.nameHit ? -1 : 1;
          return a.meta.name.localeCompare(b.meta.name);
        });
      if (members.length === 0) continue;

      const forcedOpen = query.length > 0;
      const collapsed = !forcedOpen && this.collapsedGroups.has(source);
      const groupEntry: SelectableEntry = { key: sourceKey(source), kind: "group", group: source };
      rows.push({
        key: groupEntry.key,
        selectable: groupEntry,
        text: `${collapsed ? "›" : "⌄"} ${GROUP_LABEL[source]} (${members.length} skill${members.length === 1 ? "" : "s"})`,
      });
      if (collapsed) continue;

      for (const skill of members) {
        const enabled = this.registry.isEnabled(skill.meta.name);
        const badge = this.actionBadges.get(skill.meta.name)?.text;
        const status = badge
          ? chalk.cyan(`[${badge}]`)
          : enabled
            ? ""
            : chalk.red("[disabled]");
        const author = skill.meta.author ? ` · ${skill.meta.author}` : "";
        const right = `${status}${status && (author || skillSourceLabel(skill)) ? " " : ""}(${skillSourceLabel(skill)}${author})`;
        const key = skillKey(skill.meta.name);
        const entry: SelectableEntry = { key, kind: "skill", group: source, skill };
        const left = `  ${this.selectedKey === key && !this.searchActive ? "›" : " "} ${skill.meta.name}`;
        rows.push({
          key,
          selectable: entry,
          text: enabled
            ? alignSides(left, right, contentWidth)
            : chalk.dim(alignSides(left, right, contentWidth)),
        });
        if (this.expandedSkills.has(skill.meta.name)) {
          rows.push(...this.skillDetailRows(skill, contentWidth));
        }
      }
    }

    if (rows.length === 0) {
      const message = records.length === 0
        ? "No skills discovered. Add SKILL.md under ~/.bubble/skills or .bubble/skills."
        : query
          ? `No skills matched “${this.search.getValue().trim()}”.`
          : `No ${filterLabel(this.filter).toLocaleLowerCase()} skills.`;
      rows.push({ text: chalk.gray(message) });
    }
    return rows;
  }

  private skillDetailRows(skill: SkillRecord, width: number): RenderRow[] {
    const indent = "      ";
    const detailWidth = Math.max(1, width - visibleWidth(indent));
    const rows = wrapTextWithAnsi(chalk.gray(skill.meta.description), detailWidth)
      .map((line) => ({ text: `${indent}${line}` }));
    const fields: Array<[string, string | undefined]> = [
      ["path", friendlyPath(skill.skillFile)],
      ["author", skill.meta.author],
      ["tools", skill.meta.allowedTools?.join(", ")],
      ["tags", skill.meta.tags?.join(", ")],
      ["resources", this.resourceSummary(skill)],
      ["model invocation", skill.meta.disableModelInvocation ? "manual only" : undefined],
    ];
    for (const [label, value] of fields) {
      if (!value) continue;
      const prefix = `${indent}${chalk.gray.dim(`${label}:`)} `;
      const prefixWidth = visibleWidth(`${indent}${label}: `);
      const wrapped = wrapTextWithAnsi(chalk.gray(value), Math.max(1, width - prefixWidth));
      rows.push({ text: `${prefix}${wrapped[0] ?? ""}` });
      for (const continuation of wrapped.slice(1)) {
        rows.push({ text: `${" ".repeat(prefixWidth)}${continuation}` });
      }
    }
    return rows;
  }

  private resourceSummary(skill: SkillRecord): string | undefined {
    const parts = [
      skill.resources.references.length > 0 ? `${skill.resources.references.length} references` : "",
      skill.resources.scripts.length > 0 ? `${skill.resources.scripts.length} scripts` : "",
      skill.resources.assets.length > 0 ? `${skill.resources.assets.length} assets` : "",
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  private seedCollapsedGroups(): void {
    for (const skill of this.registry.all()) this.collapsedGroups.add(skill.source);
  }

  private ensureSelection(): void {
    if (this.selectableEntries.length === 0) {
      this.selectedKey = undefined;
      return;
    }
    if (!this.selectedKey || !this.selectableEntries.some((entry) => entry.key === this.selectedKey)) {
      this.selectedKey = this.selectableEntries[0]!.key;
    }
  }

  private moveSelection(delta: number): void {
    if (this.selectableEntries.length === 0) return;
    const current = Math.max(0, this.selectableEntries.findIndex((entry) => entry.key === this.selectedKey));
    const next = Math.max(0, Math.min(this.selectableEntries.length - 1, current + delta));
    this.selectedKey = this.selectableEntries[next]!.key;
    this.manuallyScrolled = false;
    this.options.onRender();
  }

  private selectBoundary(boundary: "first" | "last"): void {
    if (this.selectableEntries.length === 0) return;
    this.selectedKey = boundary === "first"
      ? this.selectableEntries[0]!.key
      : this.selectableEntries[this.selectableEntries.length - 1]!.key;
    this.manuallyScrolled = false;
    this.options.onRender();
  }

  private selectedEntry(): SelectableEntry | undefined {
    return this.selectableEntries.find((entry) => entry.key === this.selectedKey);
  }

  private toggleExpanded(collapseOnly = false): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    this.manuallyScrolled = false;
    if (entry.kind === "group") {
      const collapsed = this.collapsedGroups.has(entry.group);
      if (collapseOnly && !collapsed) this.collapsedGroups.add(entry.group);
      else if (!collapseOnly) {
        if (collapsed) this.collapsedGroups.delete(entry.group);
        else this.collapsedGroups.add(entry.group);
      }
    } else if (entry.skill) {
      const name = entry.skill.meta.name;
      const expanded = this.expandedSkills.has(name);
      if (collapseOnly && expanded) this.expandedSkills.delete(name);
      else if (!collapseOnly) {
        if (expanded) this.expandedSkills.delete(name);
        else this.expandedSkills.add(name);
      }
    }
    this.options.onRender();
  }

  private collapseSelected(): void {
    this.toggleExpanded(true);
  }

  private toggleEnabled(): void {
    const entry = this.selectedEntry();
    if (entry?.kind !== "skill" || !entry.skill) return;
    const name = entry.skill.meta.name;
    const enabled = !this.registry.isEnabled(name);
    if (!this.registry.setEnabled(name, enabled)) return;
    this.actionBadges.set(name, { text: enabled ? "enabled" : "disabled", expiresAt: Date.now() + 1_500 });
    this.options.onSkillsChanged();
    setTimeout(() => {
      const badge = this.actionBadges.get(name);
      if (badge && badge.expiresAt <= Date.now()) {
        this.actionBadges.delete(name);
        this.options.onRender();
      }
    }, 1_550);
    this.options.onRender();
  }

  private cycleFilter(): void {
    this.filter = nextFilter(this.filter);
    this.selectedKey = undefined;
    this.offset = 0;
    this.manuallyScrolled = false;
    this.options.onRender();
  }

  private reload(): void {
    this.registry.reload();
    this.seedCollapsedGroups();
    this.selectedKey = undefined;
    this.offset = 0;
    this.manuallyScrolled = false;
    this.options.onSkillsChanged();
    this.options.onRender();
  }

  private startSearch(): void {
    if (this.searchActive) return;
    this.searchActive = true;
    this.hoveredKey = undefined;
    this.manuallyScrolled = false;
    this.search.focused = this.focused;
    this.options.onRender();
  }

  private stopSearch(): void {
    if (!this.searchActive && !this.search.getValue()) return;
    this.searchActive = false;
    this.search.setValue("");
    this.search.focused = false;
    this.selectedKey = undefined;
    this.offset = 0;
    this.manuallyScrolled = false;
    this.options.onRender();
  }

  private scroll(delta: number): void {
    const next = Math.max(0, this.offset + delta);
    if (next === this.offset) return;
    this.offset = next;
    this.manuallyScrolled = true;
    this.options.onRender();
  }

  private pruneBadges(): void {
    const now = Date.now();
    for (const [name, badge] of this.actionBadges) {
      if (badge.expiresAt <= now) this.actionBadges.delete(name);
    }
  }
}
