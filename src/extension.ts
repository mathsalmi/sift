import * as path from 'node:path';
import * as vscode from 'vscode';
import { AiService } from './ai/AiService';
import { chooseProvider, providerLabel, providerShortLabel, resolveProvider } from './ai/providers';
import { migrateAiSettings } from './ai/settings';
import { registerAgentTools } from './ai/agentTools';
import { ReviewController } from './controller/ReviewController';
import type { FileStatus, PlanCommit } from './core/types';
import { GitRunner } from './git/GitRunner';
import { SnapshotService } from './git/SnapshotService';
import { StateStore } from './state/StateStore';
import { ignoreFile, type IgnoreTarget } from './git/ignore';
import { ChangeDecorations } from './ui/ChangeDecorations';
import { CommentsManager, type ThreadComment } from './ui/Comments';
import { PlanTree, type PlanNode } from './ui/PlanTree';
import { SCHEME, SnapshotContentProvider } from './ui/SnapshotContentProvider';
import { StatusBar } from './ui/StatusBar';
import { ViewOptions } from './ui/ViewOptions';

type TreeNode = PlanNode;

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
  // Settings saved by earlier versions (sift.ai.claudeCodeModel, …) move to the generic ones.
  await migrateAiSettings().catch(() => undefined);
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

  const planView = vscode.window.createTreeView('sift.plan', {
    treeDataProvider: planTree,
    dragAndDropController: planTree,
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
   * Your messages show your GitHub picture when Sift may use VS Code's GitHub account. Until then,
   * `request` leaves a quiet "Sign in with GitHub to use Sift" entry in the Accounts menu; nothing pops up.
   */
  const updateAvatar = async (request: boolean): Promise<boolean> => {
    const session = await vscode.authentication
      .getSession('github', ['read:user'], request ? {} : { silent: true })
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
  void updateAvatar(true);
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
  statusBar = new StatusBar(controller, { busy: () => ai.busy, label: providerLabel, shortLabel: providerShortLabel });
  // Chat agents (e.g. Copilot's agent mode) can drive the review through Sift's tools.
  context.subscriptions.push(registerAgentTools(controller));

  context.subscriptions.push(
    { dispose: () => ai.dispose() },
    controller,
    viewOptions,
    planView,
    planView.onDidChangeCheckboxState(onCheckbox),
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
    // Every changed file starts in Unassigned, unless .sift/plan.json already holds a plan.
    const plan = await controller.checkPlanFile();
    if (plan.result === 'applied') {
      void vscode.window.showInformationMessage(`Review started with ${count} changed file(s) and the plan in .sift/plan.json.`);
    }
  });

  register('sift.refresh', async () => {
    await reloadState();
    await syncWithGit();
  });

  register('sift.abort', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Discard the plan?',
      {
        modal: true,
        detail:
          'The commits not made yet, approvals, comments and versions are deleted. Your files and the commits you already made are not touched.',
      },
      'Discard plan',
    );
    if (choice === 'Discard plan') {
      await controller.abort();
    }
  });

  // ---- plan ----

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

  register('sift.moveToCommit', async (node?: TreeNode | vscode.Uri, selected?: TreeNode[]) => {
    const model = controller.review;
    const paths = actionPaths(node, selected);
    if (!model || paths.length === 0) {
      return;
    }
    // The commit the files are in already, when they are all in the same one, isn't offered.
    const from = new Set(paths.map((p) => model.findFile(p)?.commitId ?? null));
    const same = from.size === 1 ? [...from][0] : undefined;
    type Pick = vscode.QuickPickItem & { commitId?: string | null };
    const picks: Pick[] = [
      ...model
        .commitsInOrder()
        .filter((c) => c.status !== 'committed' && c.id !== same)
        .map((c) => ({ label: `${c.order}. ${c.message.split('\n')[0]}`, commitId: c.id as string | null })),
      ...(same === null ? [] : [{ label: '$(inbox) Unassigned', commitId: null }]),
      { label: '$(add) New commit…' },
    ];
    const what = paths.length === 1 ? path.posix.basename(paths[0]) : `${paths.length} files`;
    // With no other commit to pick, go straight to naming a new one.
    const pick = picks.length === 1 ? picks[0] : await vscode.window.showQuickPick(picks, { placeHolder: `Move ${what} to…` });
    if (!pick) {
      return;
    }
    let commitId = pick.commitId;
    if (commitId === undefined) {
      const message = await vscode.window.showInputBox({ prompt: `Message of the new commit for ${what}`, ignoreFocusOut: true });
      if (!message?.trim()) {
        return;
      }
      commitId = await controller.newCommit(message);
    }
    await controller.moveFiles(paths, commitId);
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
    // The diff opens first: starting a commit takes a snapshot, which can take a moment on big trees.
    const model = controller.review;
    const commitId = model?.findFile(filePath)?.commitId;
    await controller.openDiff(filePath);
    if (model && commitId && model.state.session.currentCommitId !== commitId && model.getCommit(commitId).status !== 'committed') {
      await controller.startCommit(commitId);
    }
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
    const commitId = model.findFile(filePath)?.commitId ?? null;
    // Only the file's own versions: snapshots that didn't change it hold the same content.
    const picks: Array<vscode.QuickPickItem & { from: number | 'HEAD' }> = [
      { label: 'HEAD', description: 'last commit', from: 'HEAD' },
      ...model
        .fileVersions(commitId, filePath)
        .map((i, version) => ({
          label: `v${version}`,
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
    const all = actionPaths(node, selected);
    if (all.length === 0) {
      void vscode.window.showInformationMessage('Select a file in the tree or open one in the diff editor.');
      return;
    }
    // Files are reviewed as part of a commit: unassigned ones need a commit first.
    const paths = all.filter((p) => controller.review?.findFile(p)?.commitId);
    if (paths.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        `${all.length === 1 ? path.posix.basename(all[0]) + ' is' : 'These files are'} not in a commit yet. Move ${all.length === 1 ? 'it' : 'them'} to a commit to review ${all.length === 1 ? 'it' : 'them'}.`,
        'Move to commit…',
      );
      if (choice) {
        await vscode.commands.executeCommand('sift.moveToCommit', fromTab ? node : undefined, fromTab ? undefined : all.map((p) => ({ kind: 'file', path: p, commitId: null })));
      }
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

  register('sift.unexclude', async (node?: TreeNode, selected?: TreeNode[]) => {
    const nodes = selected && selected.length > 0 ? selected : node ? [node] : [];
    let patterns = nodes.flatMap((n) => (n.kind === 'excluded-entry' ? [n.pattern] : []));
    if (patterns.length === 0) {
      if (controller.excluded.length === 0) {
        void vscode.window.showInformationMessage('.git/info/exclude has no rules to remove.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        controller.excluded.map((e) => ({ label: e.label, description: e.path ? undefined : 'pattern', pattern: e.pattern })),
        { canPickMany: true, placeHolder: 'Rules to remove from .git/info/exclude' },
      );
      patterns = (picked ?? []).map((p) => p.pattern);
      if (patterns.length === 0) {
        return;
      }
    }
    const labels = new Map(controller.excluded.map((e) => [e.pattern, e.label]));
    const what = patterns.length === 1 ? (labels.get(patterns[0]) ?? patterns[0]) : `${patterns.length} rules`;
    await controller.unexclude(patterns);
    await comments.rerender();
    void vscode.window.setStatusBarMessage(`$(eye) Removed ${what} from .git/info/exclude`, 4000);
  });

  register('sift.revealFile', async (uri?: vscode.Uri) => {
    const filePath = uri instanceof vscode.Uri ? controller.reviewPath(uri) : controller.activeFilePath();
    const file = filePath ? controller.review?.findFile(filePath) : undefined;
    if (!file) {
      void vscode.window.showInformationMessage(`${uri instanceof vscode.Uri ? path.basename(uri.fsPath) : 'This file'} is not in the review: it has no uncommitted changes.`);
      return;
    }
    if (file.status === 'done' && !viewOptions.showDone) {
      const show = await vscode.window.showInformationMessage(
        `${path.posix.basename(file.path)} is approved, and approved files are hidden.`,
        'Show approved files',
      );
      if (!show) {
        return;
      }
      await viewOptions.setShowDone(true);
    }
    // Revealing expands the commit (and folders) that hold the file.
    await planView.reveal({ kind: 'file', path: file.path, commitId: file.commitId }, { select: true, focus: true, expand: true });
  });

  register('sift.nextTodo', async () => {
    await openNextTodo(controller, controller.activeFilePath() ?? undefined, true);
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

  /** The planned commits that can be committed now: the approved ones at the head of the plan, in order. */
  const readyCommits = () => {
    const model = controller.review;
    const ready: PlanCommit[] = [];
    for (const commit of model?.commitsInOrder() ?? []) {
      if (commit.status === 'committed') {
        continue;
      }
      if (model!.commitReviewStatus(commit.id) !== 'approved') {
        break;
      }
      ready.push(commit);
    }
    return ready;
  };

  /** Commits every ready commit, in order, after one confirmation. Returns how many it made. */
  const commitReady = async (andPush: boolean): Promise<number> => {
    const ready = readyCommits();
    if (ready.length === 0) {
      void vscode.window.showInformationMessage('No approved commit is waiting to be committed.');
      return 0;
    }
    const paths = ready.flatMap((c) => controller.review!.filesOf(c.id).map((f) => f.path));
    if (!(await confirmUnresolved(paths, 'Commit'))) {
      return 0;
    }
    const action = andPush ? 'Commit and push' : 'Commit';
    const choice = await vscode.window.showInformationMessage(
      ready.length === 1 ? `${action} "${ready[0].message.split('\n')[0]}"?` : `${action} ${ready.length} approved commits?`,
      { modal: true, detail: ready.length === 1 ? undefined : ready.map((c) => `${c.order}. ${c.message.split('\n')[0]}`).join('\n') },
      action,
    );
    if (choice !== action) {
      return 0;
    }
    for (const commit of ready) {
      if (controller.review?.state.session.currentCommitId !== commit.id) {
        await controller.startCommit(commit.id);
      }
      await controller.approveCurrent();
    }
    void vscode.window.showInformationMessage(`Committed ${ready.length} commit(s).${andPush ? ' Pushing…' : ''}`);
    return ready.length;
  };

  /** Pushes with VS Code's Git, which handles sign-in and publishing a new branch. */
  const push = async () => {
    await vscode.commands.executeCommand('git.push');
    await updateShipContext();
  };

  register('sift.commitApproved', async () => {
    await commitReady(false);
  });
  register('sift.commitApprovedAndPush', async () => {
    if ((await commitReady(true)) > 0) {
      await push();
    }
  });
  register('sift.push', push);

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
  register('sift.groupByStatus', () => viewOptions.setGroupByStatus(true));
  register('sift.ungroupByStatus', () => viewOptions.setGroupByStatus(false));
  register('sift.hideDone', () => viewOptions.setShowDone(false));
  register('sift.showDone', () => viewOptions.setShowDone(true));

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
    const unassigned: string[] = [];
    for (const file of model?.state.files ?? []) {
      // resourcePath of a working-tree file, and of a snapshot (a side of a version diff).
      const keys = [path.join(root, ...file.path.split('/')), `/${file.path}`];
      all.push(...keys);
      // Committed files can only be revealed, as in the sidebar.
      if (!file.commitId) {
        unassigned.push(...keys);
      } else if (!committed.has(file.commitId)) {
        byStatus[file.status].push(...keys);
      }
    }
    void vscode.commands.executeCommand('setContext', 'sift.reviewFiles', all);
    void vscode.commands.executeCommand('setContext', 'sift.todoFiles', byStatus.todo);
    void vscode.commands.executeCommand('setContext', 'sift.inProgressFiles', byStatus['in-progress']);
    void vscode.commands.executeCommand('setContext', 'sift.doneFiles', byStatus.done);
    void vscode.commands.executeCommand('setContext', 'sift.unassignedFiles', unassigned);
  };
  updateFileContext();
  context.subscriptions.push(controller.onDidChange(updateFileContext));

  /**
   * What's left to ship, for the "every file is approved" view: approved commits waiting to be
   * committed, and commits not pushed yet (or a branch never published).
   */
  const updateShipContext = async () => {
    void vscode.commands.executeCommand('setContext', 'sift.readyToCommit', readyCommits().length > 0);
    const upstream = await git.exec(['rev-list', '--count', '@{upstream}..HEAD'], { okCodes: [0, 128] }).catch(() => null);
    let unpushed = false;
    if (upstream?.exitCode === 0) {
      unpushed = Number(upstream.stdout.trim()) > 0;
    } else {
      // No upstream: worth publishing once Sift made a commit on this branch.
      unpushed = controller.review?.state.commits.some((c) => c.status === 'committed') ?? false;
    }
    void vscode.commands.executeCommand('setContext', 'sift.unpushed', unpushed);
  };
  void updateShipContext();
  context.subscriptions.push(controller.onDidChange(() => void updateShipContext()));

  const updateActiveFileContext = () => {
    const filePath = controller.activeFilePath();
    const file = filePath ? controller.review?.findFile(filePath) : undefined;
    void vscode.commands.executeCommand('setContext', 'sift.activeFileApproved', file?.status === 'done');
    void vscode.commands.executeCommand('setContext', 'sift.activeFileAssigned', Boolean(file?.commitId));
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
    if (outcome.reopened.length > 0) {
      parts.push(`No longer in git's history, back in the plan: ${quoteList(outcome.reopened)}.`);
    }
    if (parts.length > 0) {
      if (controller.review?.state.session.status === 'done') {
        parts.push('Every commit is done.');
      }
      void vscode.window.showInformationMessage(`Sift: ${parts.join(' ')}`);
    }
    if (outcome.unapproved.length > 0) {
      // Happens while you edit, so a quiet note rather than a pop-up; the file row says it too.
      const names = outcome.unapproved.map((p) => path.posix.basename(p));
      void vscode.window.setStatusBarMessage(`$(eye) Changed after approval, back to In progress: ${quoteList(names)}`, 6000);
    }
  };

  /** Picks up the saved state when another window, an agent or a hand edit changed it. */
  const reloadState = async (): Promise<void> => {
    if (await controller.reloadState()) {
      await comments.rerender();
    }
  };
  let stateTimer: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(() => void reloadState().catch(() => undefined), 300);
  };
  const stateWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(statePath)), path.basename(statePath)),
  );
  context.subscriptions.push(
    stateWatcher,
    stateWatcher.onDidChange(scheduleReload),
    stateWatcher.onDidCreate(scheduleReload),
    stateWatcher.onDidDelete(scheduleReload),
    { dispose: () => clearTimeout(stateTimer) },
  );

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
    new vscode.RelativePattern(vscode.Uri.file(gitDir), '{HEAD,logs/HEAD,refs/heads/**,refs/remotes/**}'),
  );
  // A push moves the remote refs: what's left to push changes without any review change.
  const onHeadChange = () => {
    scheduleSync();
    void updateShipContext();
  };
  // Edits to .git/info/exclude (by Sift or by hand) update the "Locally excluded" group.
  const excludePath = await ignoreFile(git, 'exclude');
  const excludeWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(excludePath)), path.basename(excludePath)),
  );
  const onExcludeChange = () => void controller.loadExcluded();
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFsChange),
    watcher.onDidCreate(onFsChange),
    watcher.onDidDelete(onFsChange),
    headWatcher,
    headWatcher.onDidChange(onHeadChange),
    headWatcher.onDidCreate(onHeadChange),
    headWatcher.onDidDelete(onHeadChange),
    excludeWatcher,
    excludeWatcher.onDidChange(onExcludeChange),
    excludeWatcher.onDidCreate(onExcludeChange),
    excludeWatcher.onDidDelete(onExcludeChange),
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

/**
 * Opens the next file to review in the commit in review. With `otherCommits` (the Next to do
 * command), moves on to the next commit with files left once this one is done.
 */
async function openNextTodo(controller: ReviewController, afterPath?: string, otherCommits = false): Promise<void> {
  const model = controller.review;
  const commitId = model?.state.session.currentCommitId ?? null;
  if (!model || (!commitId && !otherCommits)) {
    return;
  }
  const next = commitId ? model.nextTodo(commitId, afterPath) : null;
  if (next) {
    await controller.openDiff(next.path);
    return;
  }
  const elsewhere = otherCommits ? model.nextTodoInOtherCommit(commitId) : null;
  if (!elsewhere?.commitId) {
    void vscode.window.showInformationMessage(
      commitId ? 'All files in this commit are done. Approve it when ready.' : 'Every planned file is approved.',
    );
    return;
  }
  await controller.openDiff(elsewhere.path);
  await controller.startCommit(elsewhere.commitId);
  if (commitId) {
    // The commit left behind is approved but not committed yet: say so, so it isn't forgotten.
    const done = model.getCommit(commitId);
    const target = model.getCommit(elsewhere.commitId);
    void vscode.window.showInformationMessage(
      `Commit ${done.order} is approved; it isn't committed yet. Moved on to commit ${target.order}: ${target.message.split('\n')[0]}.`,
    );
  }
}
