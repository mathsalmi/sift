import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewController } from './controller/ReviewController';
import type { FileStatus } from './core/types';
import { installSlashCommand, setupClaudeCode } from './claudeSetup';
import { GitRunner } from './git/GitRunner';
import { startMcpServer, type McpHttpServer } from './mcp/server';
import { buildTools } from './mcp/tools';
import { SnapshotService } from './git/SnapshotService';
import { StateStore } from './state/StateStore';
import { BoardTree, type BoardNode } from './ui/BoardTree';
import { CommentsManager } from './ui/Comments';
import { PlanTree, type PlanNode } from './ui/PlanTree';
import { SCHEME, SnapshotContentProvider } from './ui/SnapshotContentProvider';
import { StatusBar } from './ui/StatusBar';

type TreeNode = PlanNode | BoardNode;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }

  const probe = new GitRunner(folder.uri.fsPath);
  const root = await probe.run(['rev-parse', '--show-toplevel']).then(
    (out) => out.trim(),
    () => null,
  );
  if (!root) {
    return;
  }

  const git = new GitRunner(root);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const config = vscode.workspace.getConfiguration('sift');
  const maxMb = config.get<number>('snapshotMaxFileSizeMB', 5);
  const snapshots = await SnapshotService.create(git, Math.round(maxMb * 1024 * 1024));

  const stateLocation = config.get<'repo' | 'workspaceStorage'>('stateLocation', 'repo');
  const useRepo = stateLocation === 'repo' || !context.storageUri;
  const statePath = useRepo
    ? path.join(root, '.sift', 'state.json')
    : path.join(context.storageUri!.fsPath, 'state.json');

  const controller = new ReviewController(root, gitDir, git, snapshots, new StateStore(statePath), useRepo);
  const planTree = new PlanTree(controller);
  const boardTree = new BoardTree(controller);

  const planView = vscode.window.createTreeView('sift.plan', {
    treeDataProvider: planTree,
    dragAndDropController: planTree,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const boardView = vscode.window.createTreeView('sift.board', {
    treeDataProvider: boardTree,
    canSelectMany: true,
  });

  const comments = new CommentsManager(controller);

  context.subscriptions.push(
    controller,
    planView,
    boardView,
    comments,
    new StatusBar(controller),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new SnapshotContentProvider(snapshots)),
  );

  const port = config.get<number>('mcpPort', 47821);
  const token = await workspaceToken(context, root);
  const promptText = await fs
    .readFile(vscode.Uri.joinPath(context.extensionUri, 'resources', 'sift.md').fsPath, 'utf8')
    .catch(() => '');
  const mcp = await startMcp(controller, port, token, promptText);
  context.subscriptions.push({ dispose: () => void mcp?.close() });

  const register = (id: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(handler)));
  };

  // ---- session ----

  register('sift.start', async () => {
    const count = await controller.startReview();
    const choice = await vscode.window.showInformationMessage(
      `Review started with ${count} changed file(s). Load a plan from .sift/plan.json, or create commits by hand.`,
      'Load plan',
      'New commit',
    );
    if (choice === 'Load plan') {
      await vscode.commands.executeCommand('sift.loadPlan');
    }
    if (choice === 'New commit') {
      await vscode.commands.executeCommand('sift.newCommit');
    }
  });

  register('sift.refresh', async () => {
    if (await controller.headMovedOutside()) {
      const choice = await vscode.window.showWarningMessage(
        'HEAD changed outside Sift. Accept the new HEAD?',
        { modal: true },
        'Accept',
      );
      if (choice !== 'Accept') {
        return;
      }
      await controller.resyncHead();
      return;
    }
    await controller.refresh();
  });

  register('sift.abort', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Abort the review? Plan, statuses and snapshots are deleted. Your files and existing commits are not touched.',
      { modal: true },
      'Abort',
    );
    if (choice === 'Abort') {
      await controller.abort();
    }
  });

  // ---- plan ----

  register('sift.loadPlan', async () => {
    const model = controller.review;
    if (model && model.state.commits.some((c) => c.status !== 'committed')) {
      const choice = await vscode.window.showWarningMessage(
        'Loading a plan replaces all commits that are not committed yet.',
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') {
        return;
      }
    }
    const result = await controller.loadPlan();
    const extra = result.unassigned > 0 ? ` ${result.unassigned} file(s) left unassigned.` : '';
    void vscode.window.showInformationMessage(`Loaded ${result.commits} commit(s).${extra}`);
  });

  register('sift.newCommit', async () => {
    const message = await vscode.window.showInputBox({ prompt: 'Commit message', ignoreFocusOut: true });
    if (!message?.trim()) {
      return;
    }
    await controller.newCommit(message);
  });

  register('sift.renameCommit', async (node?: PlanNode) => {
    const commitId = commitIdOf(node) ?? controller.review?.state.session.currentCommitId;
    if (!commitId || !controller.review) {
      return;
    }
    const current = controller.review.getCommit(commitId).message;
    const message = await vscode.window.showInputBox({ prompt: 'Commit message', value: current, ignoreFocusOut: true });
    if (!message?.trim()) {
      return;
    }
    await controller.renameCommit(commitId, message);
  });

  register('sift.deleteCommit', async (node?: PlanNode) => {
    const commitId = commitIdOf(node);
    if (commitId) {
      await controller.deleteCommit(commitId);
    }
  });

  register('sift.moveCommitUp', async (node?: PlanNode) => {
    const commitId = commitIdOf(node);
    if (commitId) {
      await controller.moveCommit(commitId, -1);
    }
  });

  register('sift.moveCommitDown', async (node?: PlanNode) => {
    const commitId = commitIdOf(node);
    if (commitId) {
      await controller.moveCommit(commitId, 1);
    }
  });

  register('sift.moveToCommit', async (node?: TreeNode, selected?: TreeNode[]) => {
    const model = controller.review;
    const paths = selectedPaths(controller, node, selected);
    if (!model || paths.length === 0) {
      return;
    }
    const picks = [
      { label: '$(inbox) Unassigned', commitId: null as string | null },
      ...model
        .commitsInOrder()
        .filter((c) => c.status !== 'committed')
        .map((c) => ({ label: `${c.order}. ${c.message}`, commitId: c.id as string | null })),
    ];
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: `Move ${paths.length} file(s) to…` });
    if (pick) {
      await controller.moveFiles(paths, pick.commitId);
    }
  });

  // ---- review loop ----

  register('sift.startCommit', async (node?: PlanNode) => {
    const model = controller.review;
    let commitId = commitIdOf(node);
    if (!commitId && model) {
      const pick = await vscode.window.showQuickPick(
        model
          .commitsInOrder()
          .filter((c) => c.status !== 'committed')
          .map((c) => ({ label: `${c.order}. ${c.message}`, commitId: c.id })),
        { placeHolder: 'Commit to review' },
      );
      commitId = pick?.commitId;
    }
    if (!commitId) {
      return;
    }
    await controller.startCommit(commitId);
    await openNextTodo(controller);
  });

  register('sift.openDiff', async (filePath: string) => {
    await controller.openDiff(filePath);
  });

  register('sift.toggleDiffMode', async () => {
    controller.diffMode = controller.diffMode === 'round' ? 'cumulative' : 'round';
    const active = controller.activeFilePath();
    if (active) {
      await controller.openDiff(active);
    }
    await controller.notify();
  });

  register('sift.compareVersions', async () => {
    const model = controller.review;
    const filePath = controller.activeFilePath();
    const commitId = filePath ? model?.findFile(filePath)?.commitId : null;
    if (!model || !filePath || !commitId) {
      void vscode.window.showInformationMessage('Open a file of a commit in review first.');
      return;
    }
    const versions = model.iterationsOf(commitId).map((i) => ({
      label: `v${i.n}`,
      description: `${i.author} · ${new Date(i.createdAt).toLocaleString()}`,
      n: i.n,
    }));
    if (versions.length < 2) {
      void vscode.window.showInformationMessage('This commit has only one version so far.');
      return;
    }
    const from = await vscode.window.showQuickPick(versions, { placeHolder: 'Compare from (left)' });
    if (!from) {
      return;
    }
    const to = await vscode.window.showQuickPick(
      versions.filter((v) => v.n !== from.n),
      { placeHolder: 'Compare to (right)' },
    );
    if (!to) {
      return;
    }
    await controller.openDiff(filePath, { from: from.n, to: to.n });
  });

  register('sift.takeSnapshot', async () => {
    const n = await controller.takeSnapshot('user');
    if (n === null) {
      void vscode.window.showInformationMessage('Nothing changed since the last version.');
      return;
    }
    void vscode.window.showInformationMessage(`Snapshot v${n} taken. "This round" diffs now show v${n - 1} ↔ v${n}.`);
  });

  const setStatus = (status: FileStatus) => async (node?: TreeNode, selected?: TreeNode[]) => {
    const paths = selectedPaths(controller, node, selected);
    if (paths.length === 0) {
      void vscode.window.showInformationMessage('Select a file in the tree or open one in the diff editor.');
      return;
    }
    await controller.setStatus(paths, status);
    if (status === 'done' && !node) {
      await openNextTodo(controller, paths[0]);
    }
  };
  register('sift.markDone', setStatus('done'));
  register('sift.markInProgress', setStatus('in-progress'));
  register('sift.markTodo', setStatus('todo'));

  register('sift.nextTodo', async () => {
    await openNextTodo(controller, controller.activeFilePath() ?? undefined);
  });

  register('sift.approveCommit', async (node?: PlanNode) => {
    const model = controller.review;
    const commitId = commitIdOf(node) ?? model?.state.session.currentCommitId;
    if (!model || !commitId) {
      void vscode.window.showInformationMessage('Start reviewing a commit first.');
      return;
    }
    if (model.state.session.currentCommitId !== commitId) {
      void vscode.window.showInformationMessage('Only the commit in review can be approved.');
      return;
    }
    const commit = model.getCommit(commitId);
    const blocker = model.approvalBlocker(commitId);
    if (blocker) {
      void vscode.window.showWarningMessage(blocker);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Commit ${model.filesOf(commitId).length} file(s) as "${commit.message}"?`,
      { modal: true },
      'Commit',
    );
    if (choice !== 'Commit') {
      return;
    }
    const result = await controller.approveCurrent();
    if (result.nextCommitId) {
      void vscode.window.showInformationMessage(`Committed ${result.sha.slice(0, 7)}. Next commit is in review.`);
      await openNextTodo(controller);
      return;
    }
    void vscode.window.showInformationMessage(`Committed ${result.sha.slice(0, 7)}. All planned commits are done.`);
  });

  register('sift.toggleBoardScope', async () => {
    controller.boardShowAll = !controller.boardShowAll;
    await controller.notify();
  });

  // ---- comments and the loop with Claude ----

  register('sift.comment.create', async (reply: vscode.CommentReply) => {
    await comments.create(reply);
  });
  register('sift.comment.reply', async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
  });
  register('sift.comment.resolve', async (thread: vscode.CommentThread) => {
    await comments.resolve(thread, true);
  });
  register('sift.comment.reopen', async (thread: vscode.CommentThread) => {
    await comments.resolve(thread, false);
  });
  register('sift.comment.delete', async (thread: vscode.CommentThread) => {
    await comments.delete(thread);
  });

  register('sift.sendToClaude', async () => {
    const count = await controller.sendToClaude();
    void vscode.window.showInformationMessage(
      `Sent ${count} comment(s) to Claude. If Claude isn't waiting, run /sift in Claude Code.`,
      'Copy prompt',
    ).then((choice) => {
      if (choice === 'Copy prompt') {
        void vscode.commands.executeCommand('sift.copyPrompt');
      }
    });
  });

  register('sift.toggleExplanations', async () => {
    const model = controller.review;
    if (!model) {
      return;
    }
    await controller.setShowExplanations(!model.state.session.showExplanations);
  });

  register('sift.copyPrompt', async () => {
    await vscode.env.clipboard.writeText(
      'Use the sift MCP tools: call review_get_feedback, address every sent thread, reply to each with review_reply, then call review_mark_ready.',
    );
    void vscode.window.showInformationMessage('Prompt copied. Paste it into Claude Code.');
  });

  const slashCommandSource = vscode.Uri.joinPath(context.extensionUri, 'resources', 'sift.md').fsPath;

  register('sift.setupClaude', async () => {
    if (!mcp) {
      throw new Error(`The MCP server is not running (port ${port}). Change sift.mcpPort and reload the window.`);
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Sift: setting up Claude Code…' },
      () => setupClaudeCode({ root, port: mcp.port, token, slashCommandSource }),
    );

    if (result.ok) {
      void vscode.window.showInformationMessage(
        'Claude Code is set up for this repo. Restart Claude Code (terminal or VS Code panel), then run /sift.',
        { modal: true, detail: result.steps.map((s) => `✓ ${s.label}`).join('\n') },
      );
      return;
    }

    const failed = result.steps.find((s) => !s.ok);
    const detail = result.steps
      .map((s) => `${s.ok ? '✓' : '✗'} ${s.label}${s.detail ? `\n   ${s.detail}` : ''}`)
      .join('\n');
    const choice = await vscode.window.showErrorMessage(
      `Claude Code setup failed: ${failed?.label ?? 'unknown step'}.`,
      { modal: true, detail: `${detail}\n\nManual fallback: copy the command and run it in a terminal at ${root}.` },
      'Copy command',
    );
    if (choice === 'Copy command') {
      await vscode.env.clipboard.writeText(result.command);
      void vscode.window.showInformationMessage('Command copied. Paste it into a terminal at the repo root.');
    }
  });

  register('sift.installSlashCommand', async () => {
    const step = await installSlashCommand(slashCommandSource);
    if (!step.ok) {
      throw new Error(step.detail ?? 'Could not install /sift.');
    }
    void vscode.window.showInformationMessage(`${step.label}. Restart Claude Code to pick it up.`);
  });

  // ---- file watcher: keep counts and the file list current ----

  let timer: NodeJS.Timeout | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  const onFsChange = (uri: vscode.Uri) => {
    if (!controller.review) {
      return;
    }
    const relative = path.relative(root, uri.fsPath);
    if (relative.startsWith('.git') || relative.startsWith('.sift')) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller
        .refresh()
        .then(() => comments.rerender())
        .catch(() => undefined);
    }, 500);
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFsChange),
    watcher.onDidCreate(onFsChange),
    watcher.onDidDelete(onFsChange),
    { dispose: () => clearTimeout(timer) },
  );

  await controller.init();
}

export function deactivate(): void {}

async function startMcp(
  controller: ReviewController,
  port: number,
  token: string,
  promptText: string,
): Promise<McpHttpServer | null> {
  const tools = buildTools(controller, {
    notify: (message) => {
      void vscode.window.showInformationMessage(`Claude: ${message}`);
    },
  });
  try {
    return await startMcpServer(tools, port, token, promptText);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Sift: could not start the MCP server on port ${port} (${(error as Error).message}). Set sift.mcpPort to a free port and reload.`,
    );
    return null;
  }
}

/** One bearer token per repo, kept in VS Code's secret storage. */
async function workspaceToken(context: vscode.ExtensionContext, root: string): Promise<string> {
  const key = `sift.token:${root}`;
  const existing = await context.secrets.get(key);
  if (existing) {
    return existing;
  }
  const token = randomBytes(24).toString('hex');
  await context.secrets.store(key, token);
  return token;
}

function guarded(handler: (...args: never[]) => unknown) {
  return async (...args: never[]) => {
    try {
      await handler(...args);
    } catch (error) {
      void vscode.window.showErrorMessage(`Sift: ${(error as Error).message}`);
    }
  };
}

function commitIdOf(node?: PlanNode): string | undefined {
  if (node && node.kind === 'commit') {
    return node.commitId;
  }
  return undefined;
}

/** Paths from a tree selection, or the file in the active editor. */
function selectedPaths(controller: ReviewController, node?: TreeNode, selected?: TreeNode[]): string[] {
  const nodes = selected && selected.length > 0 ? selected : node ? [node] : [];
  const paths = nodes.filter((n) => n.kind === 'file').map((n) => (n as { path: string }).path);
  if (paths.length > 0) {
    return paths;
  }
  const active = controller.activeFilePath();
  return active ? [active] : [];
}

async function openNextTodo(controller: ReviewController, afterPath?: string): Promise<void> {
  const model = controller.review;
  const commitId = model?.state.session.currentCommitId;
  if (!model || !commitId) {
    return;
  }
  const next = model.nextTodo(commitId, afterPath);
  if (!next) {
    void vscode.window.showInformationMessage('All files in this commit are done. Approve it when ready.');
    return;
  }
  await controller.openDiff(next.path);
}
