import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai/AiService';
import { chooseProvider, providerLabel, resolveProvider } from './ai/providers';
import { ReviewController } from './controller/ReviewController';
import type { FileStatus } from './core/types';
import { GitRunner } from './git/GitRunner';
import { SnapshotService } from './git/SnapshotService';
import { StateStore } from './state/StateStore';
import { BoardTree, type BoardNode } from './ui/BoardTree';
import type { IgnoreTarget } from './git/ignore';
import { ChangeDecorations } from './ui/ChangeDecorations';
import { CommentsManager, type ThreadComment } from './ui/Comments';
import { PlanTree, type PlanNode } from './ui/PlanTree';
import { SCHEME, SnapshotContentProvider } from './ui/SnapshotContentProvider';
import { StatusBar } from './ui/StatusBar';
import { ViewOptions } from './ui/ViewOptions';

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
  const viewOptions = new ViewOptions(context.globalState);
  const planTree = new PlanTree(controller, viewOptions);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new ChangeDecorations()));
  const boardTree = new BoardTree(controller, viewOptions);

  const planView = vscode.window.createTreeView('sift.plan', {
    treeDataProvider: planTree,
    dragAndDropController: planTree,
    canSelectMany: true,
    manageCheckboxStateManually: true,
  });
  const boardView = vscode.window.createTreeView('sift.board', {
    treeDataProvider: boardTree,
    canSelectMany: true,
    manageCheckboxStateManually: true,
  });

  /**
   * Asks before approving files that still have unresolved comment threads, unless the user
   * said not to ask again. Returns whether to go on.
   */
  const confirmUnresolved = async (paths: string[], action: string): Promise<boolean> => {
    const open = controller.review?.unresolvedComments(paths) ?? [];
    if (open.length === 0 || context.globalState.get<boolean>(SKIP_UNRESOLVED_WARNING, false)) {
      return true;
    }
    const files = [...new Set(open.map((t) => t.path))];
    const where = files.length === 1 ? path.posix.basename(files[0]) : `${files.length} files`;
    const count = open.length === 1 ? '1 unresolved comment' : `${open.length} unresolved comments`;
    const dontAsk = `${action}, don't ask again`;
    const choice = await vscode.window.showWarningMessage(
      `${where} still has ${count}. ${action} anyway?`,
      { modal: true, detail: 'Resolve a thread with ✓ in its title once you are done with it.' },
      action,
      dontAsk,
    );
    if (choice === dontAsk) {
      await context.globalState.update(SKIP_UNRESOLVED_WARNING, true);
      return true;
    }
    return choice === action;
  };

  // The checkbox in front of a file approves it (checked) or takes the approval back (unchecked).
  const onCheckbox = (event: vscode.TreeCheckboxChangeEvent<TreeNode>) => {
    const approve: string[] = [];
    const unapprove: string[] = [];
    for (const [node, state] of event.items) {
      if (node.kind === 'file') {
        (state === vscode.TreeItemCheckboxState.Checked ? approve : unapprove).push(node.path);
      }
    }
    void (async () => {
      if (approve.length > 0) {
        if (await confirmUnresolved(approve, 'Approve')) {
          await controller.setStatus(approve, 'done');
        } else {
          await controller.notify(); // puts the checkbox back
        }
      }
      if (unapprove.length > 0) {
        await controller.setStatus(unapprove, 'in-progress');
      }
    })().catch((error) => void vscode.window.showErrorMessage(`Sift: ${(error as Error).message}`));
  };

  const genericAvatar = vscode.Uri.joinPath(context.extensionUri, 'resources', 'avatar-you.svg');
  const avatars = { you: genericAvatar, ai: vscode.Uri.joinPath(context.extensionUri, 'resources', 'avatar-ai.svg') };
  const comments = new CommentsManager(controller, avatars, providerLabel);

  /**
   * Your messages show your GitHub picture when VS Code is signed in to GitHub and Sift may use
   * that account. `ask` shows VS Code's "allow Sift to use your GitHub account?" prompt.
   */
  const updateAvatar = async (ask: boolean): Promise<boolean> => {
    const session = await vscode.authentication
      .getSession('github', ['read:user'], ask ? { createIfNone: true } : { silent: true })
      .then(
        (s) => s,
        () => undefined,
      );
    const next = session ? vscode.Uri.parse(`https://avatars.githubusercontent.com/u/${session.account.id}?s=64`) : genericAvatar;
    if (next.toString() !== avatars.you.toString()) {
      avatars.you = next;
      await comments.rerender();
    }
    return session !== undefined;
  };
  void updateAvatar(false);
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((event) => {
      if (event.provider.id === 'github') {
        void updateAvatar(false);
      }
    }),
  );
  let statusBar: StatusBar | undefined;
  const ai = new AiService(controller, resolveProvider, {
    onBusyChange: () => {
      statusBar?.render();
      void vscode.commands.executeCommand('setContext', 'sift.aiPlanning', ai.isPlanning);
    },
    onError: (message) => {
      void vscode.window.showErrorMessage(`Sift: the AI couldn't answer: ${message}`, 'Choose AI').then((choice) => {
        if (choice === 'Choose AI') {
          void vscode.commands.executeCommand('sift.chooseAi');
        }
      });
    },
  });
  statusBar = new StatusBar(controller, { busy: () => ai.busy, label: providerLabel });

  context.subscriptions.push(
    { dispose: () => ai.dispose() },
    controller,
    viewOptions,
    planView,
    boardView,
    planView.onDidChangeCheckboxState(onCheckbox),
    boardView.onDidChangeCheckboxState(onCheckbox),
    comments,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new SnapshotContentProvider(snapshots)),
  );

  const register = (id: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(handler)));
  };

  // ---- session ----

  register('sift.start', async () => {
    const count = await controller.startReview();
    const plan = await controller.checkPlanFile();
    if (plan.result === 'applied') {
      void vscode.window.showInformationMessage(`Review started with ${count} changed file(s) and the plan in .sift/plan.json.`);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `Review started with ${count} changed file(s). Let the AI plan the commits, or create them by hand.`,
      'Plan with AI',
      'New commit',
    );
    if (choice === 'Plan with AI') {
      await vscode.commands.executeCommand('sift.planWithAi');
    }
    if (choice === 'New commit') {
      await vscode.commands.executeCommand('sift.newCommit');
    }
  });

  register('sift.refresh', async () => {
    await syncWithGit();
  });

  register('sift.abort', async () => {
    if (!context.globalState.get<boolean>(SKIP_START_OVER_WARNING, false)) {
      const dontAsk = "Start over, don't ask again";
      const choice = await vscode.window.showWarningMessage(
        'Start over?',
        {
          modal: true,
          detail:
            'The current plan is lost: commits not made yet, approvals, comments and versions. Your files and the commits you already made are not touched.',
        },
        'Start over',
        dontAsk,
      );
      if (choice === dontAsk) {
        await context.globalState.update(SKIP_START_OVER_WARNING, true);
      } else if (choice !== 'Start over') {
        return;
      }
    }
    await controller.abort();
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
    // Opening a file of another planned commit puts that commit in review.
    const model = controller.review;
    const commitId = model?.findFile(filePath)?.commitId;
    if (model && commitId && model.state.session.currentCommitId !== commitId && model.getCommit(commitId).status !== 'committed') {
      await controller.startCommit(commitId);
    }
    await controller.openDiff(filePath);
  });

  const setDiffMode = async (mode: 'round' | 'cumulative') => {
    controller.diffMode = mode;
    await vscode.commands.executeCommand('setContext', 'sift.diffMode', mode);
    const active = controller.activeFilePath();
    if (active) {
      await controller.openDiff(active);
    }
    await controller.notify();
  };
  void vscode.commands.executeCommand('setContext', 'sift.diffMode', controller.diffMode);
  register('sift.toggleDiffMode', () => setDiffMode(controller.diffMode === 'round' ? 'cumulative' : 'round'));
  register('sift.diffRound', () => setDiffMode('round'));
  register('sift.diffRoundOn', () => setDiffMode('round'));
  register('sift.diffCumulative', () => setDiffMode('cumulative'));
  register('sift.diffCumulativeOn', () => setDiffMode('cumulative'));

  register('sift.compareVersions', async () => {
    const model = controller.review;
    const filePath = controller.activeFilePath();
    if (!model || !filePath) {
      void vscode.window.showInformationMessage('Open a file of the review first.');
      return;
    }
    const commitId = model.findFile(filePath)?.commitId;
    const picks: Array<vscode.QuickPickItem & { from: number | 'HEAD' }> = [
      { label: 'HEAD', description: 'last commit', from: 'HEAD' },
      ...(commitId ? model.iterationsOf(commitId) : [])
        .map((i) => ({
          label: `v${i.n}`,
          description: `${i.author === 'initial' ? 'start of the review' : `after ${i.author === 'ai' ? 'AI' : 'your'} changes`} · ${new Date(i.createdAt).toLocaleString()}`,
          from: i.n as number | 'HEAD',
        }))
        .reverse(),
    ];
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: `Compare ${path.posix.basename(filePath)} now with…` });
    if (pick) {
      await controller.openDiff(filePath, { from: pick.from });
    }
  });

  register('sift.takeSnapshot', async () => {
    const n = await controller.takeSnapshot('user');
    if (n === null) {
      void vscode.window.showInformationMessage('Nothing changed since the last version.');
      return;
    }
    void vscode.window.showInformationMessage(`Snapshot v${n} taken. "This round" diffs now show v${n - 1} ↔ v${n}.`);
  });

  /** Files a file action applies to: the clicked tab, the selected tree rows, or the active editor. */
  const actionPaths = (node?: TreeNode | vscode.Uri, selected?: TreeNode[]): string[] => {
    if (node instanceof vscode.Uri) {
      // From an editor tab's context menu the argument is the tab's file.
      const tabPath = controller.reviewPath(node);
      return tabPath ? [tabPath] : [];
    }
    return selectedPaths(controller, node, selected);
  };

  const setStatus = (status: FileStatus) => async (node?: TreeNode | vscode.Uri, selected?: TreeNode[]) => {
    const fromTab = node instanceof vscode.Uri;
    const paths = actionPaths(node, selected);
    if (paths.length === 0) {
      void vscode.window.showInformationMessage('Select a file in the tree or open one in the diff editor.');
      return;
    }
    if (status === 'done' && !(await confirmUnresolved(paths, 'Approve'))) {
      return;
    }
    await controller.setStatus(paths, status);
    if (status === 'done' && !node && !fromTab) {
      await openNextTodo(controller, paths[0]);
    }
  };
  register('sift.markDone', setStatus('done'));
  register('sift.unapproveFile', setStatus('in-progress'));
  register('sift.markInProgress', setStatus('in-progress'));
  register('sift.markTodo', setStatus('todo'));

  const ignore = (target: IgnoreTarget) => async (node?: TreeNode | vscode.Uri, selected?: TreeNode[]) => {
    const paths = actionPaths(node, selected);
    if (paths.length === 0) {
      void vscode.window.showInformationMessage('Select a file in the tree or open one in the diff editor.');
      return;
    }
    const where = target === 'gitignore' ? '.gitignore' : '.git/info/exclude';
    const tracked = await controller.trackedPaths(paths);
    if (tracked.length > 0) {
      const names = tracked.length === 1 ? path.posix.basename(tracked[0]) : `${tracked.length} of these files`;
      const choice = await vscode.window.showWarningMessage(
        `Git already tracks ${names}, so adding ${tracked.length === 1 ? 'it' : 'them'} to ${where} won't hide the changes.`,
        {
          modal: true,
          detail: 'Ignore rules only apply to untracked files. To stop tracking, run "git rm --cached <file>" and commit that.',
        },
        `Add to ${where} anyway`,
      );
      if (!choice) {
        return;
      }
    }
    await controller.ignoreFiles(paths, target);
    await comments.rerender();
    const what = paths.length === 1 ? path.posix.basename(paths[0]) : `${paths.length} files`;
    void vscode.window.setStatusBarMessage(`$(eye-closed) Added ${what} to ${where}`, 4000);
  };
  register('sift.ignoreFile', ignore('gitignore'));
  register('sift.excludeFile', ignore('exclude'));

  register('sift.revealFile', async (uri?: vscode.Uri) => {
    const filePath = uri instanceof vscode.Uri ? controller.reviewPath(uri) : controller.activeFilePath();
    const file = filePath ? controller.review?.findFile(filePath) : undefined;
    if (!file) {
      void vscode.window.showInformationMessage(`${uri instanceof vscode.Uri ? path.basename(uri.fsPath) : 'This file'} is not in the review: it has no uncommitted changes.`);
      return;
    }
    // Revealing expands the commit (and folders) that hold the file.
    await planView.reveal({ kind: 'file', path: file.path, commitId: file.commitId }, { select: true, focus: true, expand: true });
  });

  register('sift.nextTodo', async () => {
    await openNextTodo(controller, controller.activeFilePath() ?? undefined);
  });

  const openAdjacent = (delta: -1 | 1) => async () => {
    const model = controller.review;
    const current = controller.activeFilePath();
    if (!model || !current) {
      void vscode.window.showInformationMessage('Open a file of the review first.');
      return;
    }
    const next = model.adjacentFile(current, delta);
    if (!next) {
      void vscode.window.showInformationMessage(
        delta > 0 ? 'This is the last file of the commit.' : 'This is the first file of the commit.',
      );
      return;
    }
    await controller.openDiff(next.path);
  };
  register('sift.previousFile', openAdjacent(-1));
  register('sift.nextFile', openAdjacent(1));

  register('sift.approveCommit', async (node?: PlanNode) => {
    const model = controller.review;
    const commitId = commitIdOf(node) ?? model?.state.session.currentCommitId;
    if (!model || !commitId) {
      void vscode.window.showInformationMessage('Start reviewing a commit first.');
      return;
    }
    const commit = model.getCommit(commitId);
    const blocker = model.approvalBlocker(commitId);
    if (blocker) {
      void vscode.window.showWarningMessage(blocker);
      return;
    }
    if (!(await confirmUnresolved(model.filesOf(commitId).map((f) => f.path), 'Commit'))) {
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
    if (model.state.session.currentCommitId !== commitId) {
      await controller.startCommit(commitId);
    }
    const result = await controller.approveCurrent();
    if (result.nextCommitId) {
      void vscode.window.showInformationMessage(`Committed ${result.sha.slice(0, 7)}. Next commit is in review.`);
      await openNextTodo(controller);
      return;
    }
    void vscode.window.showInformationMessage(`Committed ${result.sha.slice(0, 7)}. All planned commits are done.`);
  });

  register('sift.collapseAll', () => viewOptions.setCollapsed(true));
  register('sift.expandAll', () => viewOptions.setCollapsed(false));
  register('sift.viewAsTree', () => viewOptions.setAsTree(true));
  register('sift.viewAsList', () => viewOptions.setAsTree(false));

  register('sift.toggleBoardScope', async () => {
    controller.boardShowAll = !controller.boardShowAll;
    await controller.notify();
  });

  // ---- AI: plan and comment threads ----

  register('sift.chooseAi', async () => {
    if (await chooseProvider()) {
      statusBar?.render();
      void vscode.window.showInformationMessage(`Sift will use ${providerLabel()}.`);
    }
  });

  register('sift.planWithAi', async () => {
    const model = controller.review;
    if (model && model.state.commits.some((c) => c.status !== 'committed')) {
      const choice = await vscode.window.showWarningMessage(
        'Plan again with AI? This replaces the commits that are not committed yet.',
        { modal: true },
        'Replace',
      );
      if (choice !== 'Replace') {
        return;
      }
    }
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Sift: ${providerLabel()} is planning your commits…`,
        cancellable: true,
      },
      (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return ai.planCommits(abort.signal);
      },
    );
    const extra = result.unassigned > 0 ? ` ${result.unassigned} file(s) left unassigned.` : '';
    const choice = await vscode.window.showInformationMessage(
      `Sift: ${result.model} planned ${result.commits} commit(s).${extra}`,
      'Review first commit',
    );
    if (choice === 'Review first commit') {
      const first = controller.review?.commitsInOrder().find((c) => c.status !== 'committed');
      if (first) {
        await controller.startCommit(first.id);
        await openNextTodo(controller);
      }
    }
  });

  const askAi = async (threadIds?: string[]) => {
    const count = await ai.ask(threadIds);
    void vscode.window.setStatusBarMessage(`$(sparkle) Asked ${providerLabel()} about ${count} comment(s)…`, 4000);
  };

  register('sift.askAi', async () => {
    await askAi();
  });
  register('sift.comment.ask', async (reply: vscode.CommentReply) => {
    await askAi([await comments.reply(reply)]);
  });
  register('sift.comment.askThread', async (thread: vscode.CommentThread) => {
    const id = comments.threadId(thread);
    if (id) {
      await askAi([id]);
    }
  });
  register('sift.comment.cancelAsk', async (thread: vscode.CommentThread) => {
    const id = comments.threadId(thread);
    if (id) {
      ai.cancel(id);
    }
  });

  register('sift.comment.create', async (reply: vscode.CommentReply) => {
    await comments.create(reply);
  });
  register('sift.comment.reply', async (reply: vscode.CommentReply) => {
    await comments.reply(reply);
  });
  register('sift.useGithubAvatar', async () => {
    if (await updateAvatar(true)) {
      void vscode.window.showInformationMessage('Sift: your comments now show your GitHub picture.');
    }
  });
  register('sift.comment.copy', async (comment: ThreadComment) => {
    await comments.copy(comment);
  });
  register('sift.comment.edit', async (comment: ThreadComment) => {
    comments.startEdit(comment);
  });
  register('sift.comment.saveEdit', async (comment: ThreadComment) => {
    await comments.saveEdit(comment);
  });
  register('sift.comment.cancelEdit', async (comment: ThreadComment) => {
    comments.cancelEdit(comment);
  });
  register('sift.comment.deleteMessage', async (comment: ThreadComment) => {
    await comments.deleteMessage(comment);
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

  register('sift.toggleExplanations', async () => {
    const model = controller.review;
    if (!model) {
      return;
    }
    await controller.setShowExplanations(!model.state.session.showExplanations);
  });

  // ---- plan file: a plan written to .sift/plan.json (by hand or by another tool) shows up without any click ----

  let planBusy = false;
  const checkPlanFile = async () => {
    if (planBusy) {
      return;
    }
    planBusy = true;
    try {
      const outcome = await controller.checkPlanFile();
      if (outcome.result === 'applied') {
        const extra = outcome.unassigned > 0 ? ` ${outcome.unassigned} file(s) left unassigned.` : '';
        void vscode.window.showInformationMessage(`Sift: loaded the plan in .sift/plan.json with ${outcome.commits} commit(s).${extra}`);
      }
      if (outcome.result === 'needs-confirm') {
        planBusy = false;
        const choice = await vscode.window.showInformationMessage(
          'Sift: .sift/plan.json has a new plan. Replace the commits that are not committed yet?',
          'Replace',
          'Ignore',
        );
        if (choice === 'Replace') {
          await controller.loadPlan();
        } else if (choice === 'Ignore') {
          await controller.dismissPlanFile(outcome.hash);
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Sift: could not load .sift/plan.json: ${(error as Error).message}`);
    } finally {
      planBusy = false;
    }
  };
  let planTimer: NodeJS.Timeout | undefined;
  const planWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '.sift/plan.json'));
  const onPlanChange = () => {
    clearTimeout(planTimer);
    planTimer = setTimeout(() => void checkPlanFile(), 300);
  };
  context.subscriptions.push(
    planWatcher,
    planWatcher.onDidCreate(onPlanChange),
    planWatcher.onDidChange(onPlanChange),
    { dispose: () => clearTimeout(planTimer) },
  );

  // ---- context keys for the diff editor buttons ----

  /** Files of the review by status, so editor tab menus only offer Sift actions on review files. */
  const updateFileContext = () => {
    const model = controller.review;
    const committed = new Set(model?.state.commits.filter((c) => c.status === 'committed').map((c) => c.id));
    const all: string[] = [];
    const byStatus: Record<FileStatus, string[]> = { todo: [], 'in-progress': [], done: [] };
    for (const file of model?.state.files ?? []) {
      // resourcePath of a working-tree file, and of a snapshot (a side of a version diff).
      const keys = [path.join(root, ...file.path.split('/')), `/${file.path}`];
      all.push(...keys);
      // Committed files can only be revealed, as in the sidebar.
      if (!(file.commitId && committed.has(file.commitId))) {
        byStatus[file.status].push(...keys);
      }
    }
    void vscode.commands.executeCommand('setContext', 'sift.reviewFiles', all);
    void vscode.commands.executeCommand('setContext', 'sift.todoFiles', byStatus.todo);
    void vscode.commands.executeCommand('setContext', 'sift.inProgressFiles', byStatus['in-progress']);
    void vscode.commands.executeCommand('setContext', 'sift.doneFiles', byStatus.done);
  };
  updateFileContext();
  context.subscriptions.push(controller.onDidChange(updateFileContext));

  const updateActiveFileContext = () => {
    const filePath = controller.activeFilePath();
    const approved = filePath ? controller.review?.findFile(filePath)?.status === 'done' : false;
    void vscode.commands.executeCommand('setContext', 'sift.activeFileApproved', approved);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateActiveFileContext),
    controller.onDidChange(updateActiveFileContext),
  );

  // ---- file watcher: keep counts and the file list current ----

  /**
   * Re-reads git: new and reverted files, and commits made outside Sift (in a terminal or the
   * Source Control view), which mark their planned commits as committed instead of leaving them empty.
   */
  const syncWithGit = async (): Promise<void> => {
    if (!controller.review) {
      return;
    }
    const outcome = await controller.refresh();
    await comments.rerender();
    const parts: string[] = [];
    if (outcome.committedOutside.length > 0) {
      parts.push(`Committed outside Sift: ${quoteList(outcome.committedOutside)}.`);
    }
    if (outcome.removed.length > 0) {
      parts.push(`Removed from the plan, its changes were reverted: ${quoteList(outcome.removed)}.`);
    }
    if (parts.length > 0) {
      if (controller.review?.state.session.status === 'done') {
        parts.push('Every commit is done.');
      }
      void vscode.window.showInformationMessage(`Sift: ${parts.join(' ')}`);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const scheduleSync = () => {
    if (!controller.review) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void syncWithGit().catch(() => undefined), 500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
  const onFsChange = (uri: vscode.Uri) => {
    const relative = path.relative(root, uri.fsPath);
    if (relative.startsWith('.git') || relative.startsWith('.sift')) {
      return;
    }
    scheduleSync();
  };
  // Commits, resets and branch switches move HEAD; its reflog and refs change with it.
  const headWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,logs/HEAD,refs/heads/**}'),
  );
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFsChange),
    watcher.onDidCreate(onFsChange),
    watcher.onDidDelete(onFsChange),
    headWatcher,
    headWatcher.onDidChange(scheduleSync),
    headWatcher.onDidCreate(scheduleSync),
    headWatcher.onDidDelete(scheduleSync),
    { dispose: () => clearTimeout(timer) },
  );

  await controller.init();
  // Never await UI from activate(): VS Code shows a progress bar on the views until activation ends.
  // Catch up with commits made while VS Code was closed, then look for a plan file.
  void syncWithGit()
    .catch(() => undefined)
    .then(() => checkPlanFile());
}

export function deactivate(): void {}

/** "A", "A" and "B", or "A", "B" and 2 more. */
function quoteList(items: string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 2) {
    return quoted.join(' and ');
  }
  return `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} more`;
}

const SKIP_UNRESOLVED_WARNING = 'sift.skipUnresolvedCommentsWarning';
const SKIP_START_OVER_WARNING = 'sift.skipStartOverWarning';

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
