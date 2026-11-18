import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import type { PlanCommit, ReviewFile } from '../core/types';
import { changeUri } from './ChangeDecorations';
import { fileTreeChildren } from './fileTree';
import { COMMIT_STATUS_LABEL, commitIcon, fileCheckbox, fileDescription, fileIcon } from './icons';
import type { ViewOptions } from './ViewOptions';

export type PlanNode =
  | { kind: 'unassigned' }
  | { kind: 'commit'; commitId: string }
  | { kind: 'dir'; dir: string; label: string; commitId: string | null }
  | { kind: 'file'; path: string; commitId: string | null };

const MIME = 'application/vnd.code.tree.sift.plan';

/** Unassigned → commits → files, with drag-and-drop of files between commits. */
export class PlanTree implements vscode.TreeDataProvider<PlanNode>, vscode.TreeDragAndDropController<PlanNode> {
  private readonly changed = new vscode.EventEmitter<PlanNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(
    private readonly controller: ReviewController,
    private readonly options: ViewOptions,
  ) {
    controller.onDidChange(() => this.changed.fire(undefined));
    options.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: PlanNode): PlanNode[] {
    const model = this.controller.review;
    if (!model) {
      return [];
    }
    if (!node) {
      const roots: PlanNode[] = [];
      if (model.filesOf(null).length > 0) {
        roots.push({ kind: 'unassigned' });
      }
      for (const commit of model.commitsInOrder()) {
        roots.push({ kind: 'commit', commitId: commit.id });
      }
      return roots;
    }
    if (node.kind === 'file') {
      return [];
    }
    const commitId = node.kind === 'unassigned' ? null : node.commitId;
    const files = model.filesOf(commitId);
    if (!this.options.asTree) {
      return files.map((f) => ({ kind: 'file', path: f.path, commitId }));
    }
    return fileTreeChildren(files, node.kind === 'dir' ? node.dir : '').map((entry) =>
      entry.type === 'dir'
        ? { kind: 'dir', dir: entry.dir, label: entry.label, commitId }
        : { kind: 'file', path: entry.file.path, commitId },
    );
  }

  getParent(node: PlanNode): PlanNode | undefined {
    if (node.kind !== 'file' && node.kind !== 'dir') {
      return undefined;
    }
    const top: PlanNode = node.commitId ? { kind: 'commit', commitId: node.commitId } : { kind: 'unassigned' };
    if (!this.options.asTree || !this.controller.review) {
      return top;
    }
    // Walk down from the commit to find the folder that holds this node.
    const target = node.kind === 'dir' ? node.dir : node.path;
    let parent: PlanNode = top;
    for (;;) {
      const next: PlanNode | undefined = this.getChildren(parent).find(
        (child) => child.kind === 'dir' && target.startsWith(child.dir) && target !== child.dir,
      );
      if (!next) {
        return parent;
      }
      parent = next;
    }
  }

  getTreeItem(node: PlanNode): vscode.TreeItem {
    const model = this.controller.review;
    if (!model) {
      return new vscode.TreeItem('');
    }
    if (node.kind === 'unassigned') {
      const files = model.filesOf(null);
      const item = new vscode.TreeItem('Unassigned', this.options.state(vscode.TreeItemCollapsibleState.Expanded));
      item.id = this.options.id('unassigned');
      item.description = `${files.length} file(s)`;
      item.iconPath = new vscode.ThemeIcon('inbox', new vscode.ThemeColor('charts.orange'));
      item.contextValue = 'unassigned';
      item.tooltip = 'Files not yet in any commit. Drag them onto a commit.';
      return item;
    }
    if (node.kind === 'commit') {
      return this.commitItem(model.getCommit(node.commitId), model.filesOf(node.commitId));
    }
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.label, this.options.state(vscode.TreeItemCollapsibleState.Expanded));
      item.id = this.options.id(`dir:${node.commitId ?? 'none'}:${node.dir}`);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = vscode.Uri.file(node.dir);
      item.contextValue = 'dir';
      return item;
    }
    const file = model.state.files.find((f) => f.path === node.path && f.commitId === node.commitId);
    const committed = node.commitId !== null && model.getCommit(node.commitId).status === 'committed';
    return file ? this.fileItem(file, committed) : new vscode.TreeItem(node.path);
  }

  handleDrag(source: readonly PlanNode[], data: vscode.DataTransfer): void {
    const paths = source.filter((n) => n.kind === 'file').map((n) => (n as { path: string }).path);
    data.set(MIME, new vscode.DataTransferItem(paths));
  }

  async handleDrop(target: PlanNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item || !target) {
      return;
    }
    const paths = item.value as string[];
    let commitId: string | null = null;
    if (target.kind === 'commit') {
      commitId = target.commitId;
    }
    if (target.kind === 'file' || target.kind === 'dir') {
      commitId = target.commitId;
    }
    try {
      await this.controller.moveFiles(paths, commitId);
    } catch (error) {
      void vscode.window.showErrorMessage(String((error as Error).message));
    }
  }

  private commitItem(commit: PlanCommit, files: ReviewFile[]): vscode.TreeItem {
    const model = this.controller.review;
    const isCurrent = model?.state.session.currentCommitId === commit.id;
    const approved = files.filter((f) => f.status === 'done').length;
    const status = model?.commitReviewStatus(commit.id) ?? 'todo';
    const state = this.options.state(
      isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const title = `${commit.order}. ${commit.message.split('\n')[0]}`;
    // The commit in review is highlighted instead of getting its own icon.
    const item = new vscode.TreeItem(isCurrent ? { label: title, highlights: [[0, title.length]] } : title, state);
    item.id = this.options.id(`commit:${commit.id}`);
    item.iconPath = commitIcon(status);

    if (commit.status === 'committed') {
      item.description = `Committed ${commit.sha?.slice(0, 7) ?? ''}`;
      item.contextValue = 'commit-committed';
    } else {
      const parts = [COMMIT_STATUS_LABEL[status], `${approved}/${files.length} approved`];
      if (isCurrent) {
        parts.push('in review');
      }
      item.description = parts.join(' · ');
      item.contextValue = isCurrent ? 'commit-current' : 'commit';
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(commit.message)}**\n\n`);
    tooltip.appendMarkdown(`*${COMMIT_STATUS_LABEL[status]}* · ${approved}/${files.length} file(s) approved\n\n`);
    if (commit.intent) {
      tooltip.appendMarkdown(`${escape(commit.intent)}\n\n`);
    }
    for (const note of commit.riskNotes) {
      tooltip.appendMarkdown(`- ⚠ ${escape(note)}\n`);
    }
    item.tooltip = tooltip;
    return item;
  }

  private fileItem(file: ReviewFile, committed: boolean): vscode.TreeItem {
    const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
    item.id = `file:${file.commitId ?? 'none'}:${file.path}`;
    const model = this.controller.review;
    item.description = fileDescription(file, !this.options.asTree, (n) => model?.fileVersionAt(file.commitId, file.path, n) ?? n);
    item.iconPath = fileIcon(file);
    item.tooltip = `${file.path}\n${file.changeType} · ${STATUS_TEXT[file.status]}`;
    item.resourceUri = changeUri(file);
    if (committed) {
      item.contextValue = 'file-committed';
    } else {
      item.checkboxState = fileCheckbox(file);
      item.contextValue = `file-${file.status}`;
    }
    item.command = { command: 'sift.openDiff', title: 'Open diff', arguments: [file.path] };
    return item;
  }
}

const STATUS_TEXT: Record<ReviewFile['status'], string> = {
  todo: 'to do',
  'in-progress': 'in progress',
  done: 'approved',
};

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (char) => `\\${char}`);
}
