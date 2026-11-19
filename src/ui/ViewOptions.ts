import * as vscode from 'vscode';
import { fuzzyMatch } from './fuzzy';

export type ExpandMode = 'default' | 'all' | 'none';

/**
 * How the Plan view shows files: as a list or nested in folders, grouped by status or not, with or
 * without approved files and committed commits, filtered or not, and the last "collapse all" /
 * "expand all". The filter and the last are not remembered.
 */
export class ViewOptions implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private expandMode: ExpandMode = 'default';
  private filterText = '';
  /** Bumped on collapse/expand all: new item ids make VS Code use the new collapsible state. */
  private generation = 0;

  constructor(private readonly memento: vscode.Memento) {
    void this.updateContext();
  }

  dispose(): void {
    this.changed.dispose();
  }

  get asTree(): boolean {
    return this.memento.get<boolean>('sift.viewAsTree', false);
  }

  async setAsTree(asTree: boolean): Promise<void> {
    await this.memento.update('sift.viewAsTree', asTree);
    await this.updateContext();
    this.changed.fire();
  }

  /** Whether approved files are listed. Hidden ones disappear as soon as they are approved. */
  get showDone(): boolean {
    return this.memento.get<boolean>('sift.showDone', true);
  }

  async setShowDone(show: boolean): Promise<void> {
    await this.memento.update('sift.showDone', show);
    await this.updateContext();
    this.changed.fire();
  }

  /** Whether commits already made are listed. */
  get showCommitted(): boolean {
    return this.memento.get<boolean>('sift.showCommitted', true);
  }

  async setShowCommitted(show: boolean): Promise<void> {
    await this.memento.update('sift.showCommitted', show);
    await this.updateContext();
    this.changed.fire();
  }

  /** Fuzzy text the file paths must match; empty shows every file. */
  get filter(): string {
    return this.filterText;
  }

  async setFilter(text: string): Promise<void> {
    const next = text.trim();
    if (next === this.filterText) {
      return;
    }
    this.filterText = next;
    await this.updateContext();
    this.changed.fire();
  }

  /** The files to list: those matching the filter, without the approved ones when they are hidden. */
  visible<F extends { status: string; path: string }>(files: F[], committed = false): F[] {
    return files.filter(
      (f) => (committed || this.showDone || f.status !== 'done') && (!this.filterText || fuzzyMatch(this.filterText, f.path)),
    );
  }

  /** Whether each commit's files are split into To do / In progress / Approved. */
  get groupByStatus(): boolean {
    return this.memento.get<boolean>('sift.groupByStatus', false);
  }

  async setGroupByStatus(group: boolean): Promise<void> {
    await this.memento.update('sift.groupByStatus', group);
    await this.updateContext();
    this.changed.fire();
  }

  get collapsed(): boolean {
    return this.expandMode === 'none';
  }

  async setCollapsed(collapsed: boolean): Promise<void> {
    this.expandMode = collapsed ? 'none' : 'all';
    this.generation++;
    await this.updateContext();
    this.changed.fire();
  }

  /** The state an item gets: `fallback` until the user collapses or expands everything. */
  state(fallback: vscode.TreeItemCollapsibleState): vscode.TreeItemCollapsibleState {
    if (this.expandMode === 'all' || (this.filterText && this.expandMode === 'default')) {
      return vscode.TreeItemCollapsibleState.Expanded;
    }
    if (this.expandMode === 'none') {
      return vscode.TreeItemCollapsibleState.Collapsed;
    }
    return fallback;
  }

  /** Item id for collapsible items, so a collapse/expand all applies to items VS Code already knows. */
  id(base: string): string {
    // Filtering expands everything that matches: new ids, so VS Code takes the expanded state.
    const suffix = `${this.generation === 0 ? '' : `~${this.generation}`}${this.filterText ? '~f' : ''}`;
    return `${base}${suffix}`;
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'sift.viewAsTree', this.asTree);
    await vscode.commands.executeCommand('setContext', 'sift.treeCollapsed', this.collapsed);
    await vscode.commands.executeCommand('setContext', 'sift.hideDone', !this.showDone);
    await vscode.commands.executeCommand('setContext', 'sift.hideCommitted', !this.showCommitted);
    await vscode.commands.executeCommand('setContext', 'sift.filtering', this.filterText !== '');
    await vscode.commands.executeCommand('setContext', 'sift.groupByStatus', this.groupByStatus);
  }
}
