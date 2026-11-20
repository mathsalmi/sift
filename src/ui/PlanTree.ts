import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import type { FileStatus, PlanCommit, ReviewFile } from '../core/types';
import { changeUri } from './ChangeDecorations';
import { fileTreeChildren } from './fileTree';
import { COMMIT_STATUS_LABEL, commitIcon, fileCheckbox, fileDescription, fileIcon } from './icons';
import type { ViewOptions } from './ViewOptions';

export type PlanNode =
  | { kind: 'unassigned' }
  | { kind: 'commit'; commitId: string }
  | { kind: 'status'; status: FileStatus; commitId: string | null }
  | { kind: 'dir'; dir: string; label: string; commitId: string | null; status?: FileStatus }
  | { kind: 'file'; path: string; commitId: string | null }
  | { kind: 'excluded' }
  | { kind: 'excluded-entry'; pattern: string };

const MIME = 'application/vnd.code.tree.sift.plan';

/** The groups files fall into when grouped by status, in review order. */
const STATUS_GROUPS: Array<{ status: FileStatus; label: string; icon: string }> = [
  { status: 'todo', label: 'To do', icon: 'circle-large-outline' },
  { status: 'in-progress', label: 'In progress', icon: 'eye' },
  { status: 'done', label: 'Approved', icon: 'check' },
];

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
      // With approved files hidden, a group whose files are all approved has nothing to show.
      if (this.options.visible(model.filesOf(null)).length > 0) {
        roots.push({ kind: 'unassigned' });
      }
      for (const commit of model.commitsInOrder()) {
        const committed = commit.status === 'committed';
        if (committed && !this.options.showCommitted) {
          continue;
        }
        // Planned commits always show, even with all their files hidden, unless the filter leaves none.
        if (!this.options.filter || this.options.visible(model.filesOf(commit.id), committed).length > 0) {
          roots.push({ kind: 'commit', commitId: commit.id });
        }
      }
      if (this.controller.excluded.length > 0) {
        roots.push({ kind: 'excluded' });
      }
      return roots;
    }
    if (node.kind === 'excluded') {
      return this.controller.excluded.map((e) => ({ kind: 'excluded-entry', pattern: e.pattern }));
    }
    if (node.kind === 'file' || node.kind === 'excluded-entry') {
      return [];
    }
    const commitId = node.kind === 'unassigned' ? null : node.commitId;
    const committed = commitId !== null && model.getCommit(commitId).status === 'committed';
    let files = this.options.visible(model.filesOf(commitId), committed);
    if (this.options.groupByStatus && node.kind === 'commit') {
      return STATUS_GROUPS.filter((g) => files.some((f) => f.status === g.status)).map((g) => ({
        kind: 'status',
        status: g.status,
        commitId,
      }));
    }
    const status = node.kind === 'status' || node.kind === 'dir' ? node.status : undefined;
    if (status) {
      files = files.filter((f) => f.status === status);
    }
    if (!this.options.asTree) {
      return files.map((f) => ({ kind: 'file', path: f.path, commitId }));
    }
    return fileTreeChildren(files, node.kind === 'dir' ? node.dir : '').map((entry) =>
      entry.type === 'dir'
        ? { kind: 'dir', dir: entry.dir, label: entry.label, commitId, status }
        : { kind: 'file', path: entry.file.path, commitId },
    );
  }

  /** The files a folder row stands for: the ones shown under it, with the view's filters. */
  filesUnder(node: Extract<PlanNode, { kind: 'dir' }>): string[] {
    const model = this.controller.review;
    if (!model) {
      return [];
    }
    const committed = node.commitId !== null && model.getCommit(node.commitId).status === 'committed';
    return this.options
      .visible(model.filesOf(node.commitId), committed)
      .filter((f) => f.path.startsWith(node.dir) && (!node.status || f.status === node.status))
      .map((f) => f.path);
  }

  getParent(node: PlanNode): PlanNode | undefined {
    if (node.kind === 'excluded-entry') {
      return { kind: 'excluded' };
    }
    if (node.kind !== 'file' && node.kind !== 'dir' && node.kind !== 'status') {
      return undefined;
    }
    const group: PlanNode = node.commitId ? { kind: 'commit', commitId: node.commitId } : { kind: 'unassigned' };
    if (node.kind === 'status') {
      return group;
    }
    let top: PlanNode = group;
    if (this.options.groupByStatus) {
      const status = node.kind === 'dir' ? node.status : this.controller.review?.findFile(node.path)?.status;
      if (status) {
        top = { kind: 'status', status, commitId: node.commitId };
      }
    }
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
    if (node.kind === 'excluded') {
      const item = new vscode.TreeItem('Locally excluded', this.options.state(vscode.TreeItemCollapsibleState.Collapsed));
      item.id = this.options.id('excluded');
      item.description = `${this.controller.excluded.length} rule(s)`;
      item.iconPath = new vscode.ThemeIcon('eye-closed', new vscode.ThemeColor('disabledForeground'));
      item.contextValue = 'excluded';
      item.tooltip = 'Rules in .git/info/exclude: git ignores these files in this clone only.';
      return item;
    }
    if (node.kind === 'excluded-entry') {
      return this.excludedItem(node.pattern);
    }
    if (node.kind === 'commit') {
      return this.commitItem(model.getCommit(node.commitId), model.filesOf(node.commitId));
    }
    if (node.kind === 'status') {
      const group = STATUS_GROUPS.find((g) => g.status === node.status) ?? STATUS_GROUPS[0];
      const count = model.filesOf(node.commitId).filter((f) => f.status === node.status).length;
      const item = new vscode.TreeItem(group.label, this.options.state(vscode.TreeItemCollapsibleState.Expanded));
      item.id = this.options.id(`status:${node.commitId ?? 'none'}:${node.status}`);
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon(group.icon);
      item.contextValue = 'status';
      return item;
    }
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.label, this.options.state(vscode.TreeItemCollapsibleState.Expanded));
      item.id = this.options.id(`dir:${node.commitId ?? 'none'}:${node.status ?? 'all'}:${node.dir}`);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = vscode.Uri.file(node.dir);
      const committed = node.commitId !== null && model.getCommit(node.commitId).status === 'committed';
      item.contextValue = committed ? 'dir-committed' : node.commitId ? 'dir' : 'dir-unassigned';
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
    if (!item || !target || target.kind === 'excluded' || target.kind === 'excluded-entry') {
      return;
    }
    const paths = item.value as string[];
    let commitId: string | null = null;
    if (target.kind === 'commit') {
      commitId = target.commitId;
    }
    if (target.kind === 'file' || target.kind === 'dir' || target.kind === 'status') {
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
    const committed = commit.status === 'committed';
    const approved = files.filter((f) => f.status === 'done').length;
    const status = model?.commitReviewStatus(commit.id) ?? 'todo';
    // A commit whose files are all hidden (approved) has nothing to expand.
    const state =
      this.options.visible(files, committed).length === 0
        ? vscode.TreeItemCollapsibleState.None
        : this.options.state(isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    const title = `${commit.order}. ${commit.message.split('\n')[0]}`;
    // The commit in review is highlighted instead of getting its own icon.
    const item = new vscode.TreeItem(isCurrent ? { label: title, highlights: [[0, title.length]] } : title, state);
    item.id = this.options.id(`commit:${commit.id}`);
    item.iconPath = commitIcon(status);
    const dependencies = model?.dependenciesOf(commit.id) ?? [];

    const short = (sha?: string) => sha?.slice(0, 7) ?? '';
    if (committed && commit.revertedBy) {
      item.description = `Reverted by ${short(commit.revertedBy)}`;
      item.iconPath = new vscode.ThemeIcon('discard', new vscode.ThemeColor('disabledForeground'));
      item.contextValue = 'commit-committed-reverted';
    } else if (committed) {
      item.description = `${commit.pushed ? 'Pushed' : 'Committed'} ${short(commit.sha)}`;
      item.contextValue = commit.pushed ? 'commit-committed-pushed' : 'commit-committed-local';
    } else {
      const parts = [COMMIT_STATUS_LABEL[status], `${approved}/${files.length} approved`];
      if (dependencies.length > 0) {
        parts.push(`after ${dependencies.map((d) => d.order).join(', ')}`);
      }
      if (isCurrent) {
        parts.push('in review');
      }
      item.description = parts.join(' · ');
      item.contextValue = isCurrent ? 'commit-current' : 'commit';
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escape(commit.message)}**\n\n`);
    if (committed) {
      const state = commit.revertedBy
        ? `Reverted by ${short(commit.revertedBy)}`
        : `${commit.pushed ? 'Pushed' : 'Committed, not pushed yet'}`;
      tooltip.appendMarkdown(`*${state}* · ${short(commit.sha)} · ${files.length} file(s)\n\n`);
    } else {
      tooltip.appendMarkdown(`*${COMMIT_STATUS_LABEL[status]}* · ${approved}/${files.length} file(s) approved\n\n`);
    }
    if (commit.intent) {
      tooltip.appendMarkdown(`${escape(commit.intent)}\n\n`);
    }
    for (const note of commit.riskNotes) {
      tooltip.appendMarkdown(`- ⚠ ${escape(note)}\n`);
    }
    if (dependencies.length > 0) {
      tooltip.appendMarkdown(`\nBuilds on:\n`);
      for (const dependency of dependencies) {
        tooltip.appendMarkdown(`- ${dependency.order}. ${escape(dependency.message.split('\n')[0])}\n`);
      }
    }
    item.tooltip = tooltip;
    return item;
  }

  private excludedItem(pattern: string): vscode.TreeItem {
    const entry = this.controller.excluded.find((e) => e.pattern === pattern);
    const label = entry?.path ? path.posix.basename(entry.path) : pattern;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `excluded:${pattern}`;
    item.contextValue = 'excluded-entry';
    if (entry?.path) {
      const dir = path.posix.dirname(entry.path);
      item.description = dir === '.' ? undefined : dir;
      const uri = vscode.Uri.file(path.join(this.controller.root, entry.path));
      item.resourceUri = uri;
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: 'vscode.open', title: 'Open file', arguments: [uri] };
    } else {
      item.iconPath = new vscode.ThemeIcon('filter');
    }
    item.tooltip = `${pattern}\nin .git/info/exclude`;
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
    } else if (!file.commitId) {
      // Reviewed only once in a commit: no checkbox or status yet.
      item.contextValue = 'file-unassigned';
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = `${file.path}\n${file.changeType} · not in a commit yet: move it to one to review it`;
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
