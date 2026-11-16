import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import type { PlanCommit, ReviewFile } from '../core/types';
import { fileDescription, fileIcon } from './icons';

export type PlanNode =
  | { kind: 'unassigned' }
  | { kind: 'commit'; commitId: string }
  | { kind: 'file'; path: string; commitId: string | null };

const MIME = 'application/vnd.code.tree.sift.plan';

/** Unassigned → commits → files, with drag-and-drop of files between commits. */
export class PlanTree implements vscode.TreeDataProvider<PlanNode>, vscode.TreeDragAndDropController<PlanNode> {
  private readonly changed = new vscode.EventEmitter<PlanNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this.changed.fire(undefined));
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
    const commitId = node.kind === 'commit' ? node.commitId : null;
    return model.filesOf(commitId).map((f) => ({ kind: 'file', path: f.path, commitId }));
  }

  getParent(node: PlanNode): PlanNode | undefined {
    if (node.kind !== 'file') {
      return undefined;
    }
    return node.commitId ? { kind: 'commit', commitId: node.commitId } : { kind: 'unassigned' };
  }

  getTreeItem(node: PlanNode): vscode.TreeItem {
    const model = this.controller.review;
    if (!model) {
      return new vscode.TreeItem('');
    }
    if (node.kind === 'unassigned') {
      const files = model.filesOf(null);
      const item = new vscode.TreeItem('Unassigned', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'unassigned';
      item.description = `${files.length} file(s)`;
      item.iconPath = new vscode.ThemeIcon('inbox', new vscode.ThemeColor('charts.orange'));
      item.contextValue = 'unassigned';
      item.tooltip = 'Files not yet in any commit. Drag them onto a commit.';
      return item;
    }
    if (node.kind === 'commit') {
      return this.commitItem(model.getCommit(node.commitId), model.filesOf(node.commitId));
    }
    const file = model.state.files.find((f) => f.path === node.path && f.commitId === node.commitId);
    return file ? this.fileItem(file) : new vscode.TreeItem(node.path);
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
    if (target.kind === 'file') {
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
    const done = files.filter((f) => f.status === 'done').length;
    const state = isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(`${commit.order}. ${commit.message}`, state);
    item.id = `commit:${commit.id}`;

    if (commit.status === 'committed') {
      item.description = `committed ${commit.sha?.slice(0, 7) ?? ''}`;
      item.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.green'));
      item.contextValue = 'commit-committed';
    } else {
      const latest = model?.latestIteration(commit.id);
      const version = latest ? ` · v${latest.n}` : '';
      item.description = `${done}/${files.length} done${version}${isCurrent ? ' · in review' : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        isCurrent ? 'eye' : 'circle-large-outline',
        isCurrent ? new vscode.ThemeColor('charts.blue') : undefined,
      );
      item.contextValue = isCurrent ? 'commit-current' : 'commit';
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(commit.message)}**\n\n`);
    if (commit.intent) {
      tooltip.appendMarkdown(`${escape(commit.intent)}\n\n`);
    }
    for (const note of commit.riskNotes) {
      tooltip.appendMarkdown(`- ⚠ ${escape(note)}\n`);
    }
    item.tooltip = tooltip;
    return item;
  }

  private fileItem(file: ReviewFile): vscode.TreeItem {
    const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
    item.id = `file:${file.commitId ?? 'none'}:${file.path}`;
    item.description = fileDescription(file, true);
    item.iconPath = fileIcon(file);
    item.tooltip = `${file.path}\n${file.changeType} · ${file.status}`;
    item.resourceUri = vscode.Uri.file(file.path);
    item.contextValue = `file-${file.status}`;
    item.command = { command: 'sift.openDiff', title: 'Open diff', arguments: [file.path] };
    return item;
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (char) => `\\${char}`);
}
