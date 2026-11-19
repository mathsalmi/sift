import * as vscode from 'vscode';

export type ExpandMode = 'default' | 'all' | 'none';

/**
 * How the Plan and Board views show files: as a list or nested in folders, with or without
 * approved files, and the last "collapse all" / "expand all". Shared by both views; the
 * list/tree and approved-files choices are remembered.
 */
export class ViewOptions implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private expandMode: ExpandMode = 'default';
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

  /** The files to list: all of them, or all but the approved ones. */
  visible<F extends { status: string }>(files: F[]): F[] {
    return this.showDone ? files : files.filter((f) => f.status !== 'done');
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
    if (this.expandMode === 'all') {
      return vscode.TreeItemCollapsibleState.Expanded;
    }
    if (this.expandMode === 'none') {
      return vscode.TreeItemCollapsibleState.Collapsed;
    }
    return fallback;
  }

  /** Item id for collapsible items, so a collapse/expand all applies to items VS Code already knows. */
  id(base: string): string {
    return this.generation === 0 ? base : `${base}~${this.generation}`;
  }

  private async updateContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'sift.viewAsTree', this.asTree);
    await vscode.commands.executeCommand('setContext', 'sift.treeCollapsed', this.collapsed);
    await vscode.commands.executeCommand('setContext', 'sift.hideDone', !this.showDone);
  }
}
