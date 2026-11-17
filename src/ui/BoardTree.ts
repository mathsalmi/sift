import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import type { FileStatus, ReviewFile } from '../core/types';
import { changeUri } from './ChangeDecorations';
import { fileTreeChildren } from './fileTree';
import { fileCheckbox, fileDescription, fileIcon } from './icons';
import type { ViewOptions } from './ViewOptions';

export type BoardNode =
  | { kind: 'group'; status: FileStatus }
  | { kind: 'dir'; status: FileStatus; dir: string; label: string }
  | { kind: 'file'; path: string; commitId: string | null };

const GROUPS: Array<{ status: FileStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To do', icon: 'list-unordered' },
  { status: 'in-progress', label: 'In progress', icon: 'eye' },
  { status: 'done', label: 'Approved', icon: 'check' },
];

/** To do / In progress / Approved, for the commit in review (or all pending commits). */
export class BoardTree implements vscode.TreeDataProvider<BoardNode> {
  private readonly changed = new vscode.EventEmitter<BoardNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly controller: ReviewController,
    private readonly options: ViewOptions,
  ) {
    controller.onDidChange(() => this.changed.fire(undefined));
    options.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: BoardNode): BoardNode[] {
    if (!this.controller.review) {
      return [];
    }
    if (!node) {
      return GROUPS.map((g) => ({ kind: 'group', status: g.status }));
    }
    if (node.kind === 'file') {
      return [];
    }
    const files = this.scopeFiles().filter((f) => f.status === node.status);
    if (!this.options.asTree) {
      return files.map((f) => ({ kind: 'file', path: f.path, commitId: f.commitId }));
    }
    return fileTreeChildren(files, node.kind === 'dir' ? node.dir : '').map((entry) =>
      entry.type === 'dir'
        ? { kind: 'dir', status: node.status, dir: entry.dir, label: entry.label }
        : { kind: 'file', path: entry.file.path, commitId: entry.file.commitId },
    );
  }

  getTreeItem(node: BoardNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const group = GROUPS.find((g) => g.status === node.status) ?? GROUPS[0];
      const count = this.scopeFiles().filter((f) => f.status === node.status).length;
      const expanded = node.status === 'done' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(group.label, this.options.state(expanded));
      item.id = this.options.id(`group:${node.status}`);
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon(group.icon);
      return item;
    }
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.label, this.options.state(vscode.TreeItemCollapsibleState.Expanded));
      item.id = this.options.id(`board-dir:${node.status}:${node.dir}`);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'dir';
      return item;
    }
    const file = this.controller.review?.state.files.find((f) => f.path === node.path && f.commitId === node.commitId);
    if (!file) {
      return new vscode.TreeItem(node.path);
    }
    const label = this.options.asTree ? file.path.slice(file.path.lastIndexOf('/') + 1) : file.path;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `board:${file.commitId ?? 'none'}:${file.path}`;
    item.description = fileDescription(file, false);
    item.iconPath = fileIcon(file);
    item.resourceUri = changeUri(file);
    item.checkboxState = fileCheckbox(file);
    item.contextValue = `file-${file.status}`;
    item.command = { command: 'sift.openDiff', title: 'Open diff', arguments: [file.path] };
    return item;
  }

  private scopeFiles(): ReviewFile[] {
    const model = this.controller.review;
    if (!model) {
      return [];
    }
    const current = model.state.session.currentCommitId;
    if (current && !this.controller.boardShowAll) {
      return model.filesOf(current);
    }
    const committed = new Set(model.state.commits.filter((c) => c.status === 'committed').map((c) => c.id));
    return model.state.files
      .filter((f) => !f.commitId || !committed.has(f.commitId))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}
