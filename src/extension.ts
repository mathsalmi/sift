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
    const run = async (...args: never[]) => {
      // Work on the latest saved plan, even when an outside edit landed just before the watcher noticed it.
      await reloadState().catch(() => undefined);
      return handler(...args);
    };
    context.subscriptions.push(vscode.commands.registerCommand(id, guarded(run)));
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
    return selectedPaths(controller, planTree, node, selected);
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
    // A folder gets one rule for the whole folder, so files added to it later stay hidden too.
    const rows = node instanceof vscode.Uri ? [] : selected && selected.length > 0 ? selected : node ? [node] : [];
    const dirs = rows.flatMap((n) => (n.kind === 'dir' ? [n.dir] : []));
    const files = paths.filter((p) => !dirs.some((d) => p.startsWith(d)));
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
    await controller.ignoreFiles(files, target, dirs);
    await comments.rerender();
    const what =
      dirs.length === 1 && files.length === 0
        ? dirs[0]
        : paths.length === 1
          ? path.posix.basename(paths[0])
          : `${paths.length} files`;
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
    const inCommitted = file.commitId !== null && controller.review?.getCommit(file.commitId).status === 'committed';
    if (inCommitted && !viewOptions.showCommitted) {
      const show = await vscode.window.showInformationMessage(
        `${path.posix.basename(file.path)} is in a committed commit, and committed commits are hidden.`,
        'Show committed commits',
      );
      if (!show) {
        return;
      }
      await viewOptions.setShowCommitted(true);
    }
    if (viewOptions.filter && viewOptions.visible([file], true).length === 0) {
      await viewOptions.setFilter('');
    }
    if (!inCommitted && file.status === 'done' && !viewOptions.showDone) {
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

  /** "1. Subject" of a commit, for messages and pickers. */
  const label = (commit: PlanCommit) => `${commit.order}. ${commit.message.split('\n')[0]}`;

  /**
   * Commits `target` with the commits it builds on, or with no target every approved commit that
   * can be committed (falling back to the commit in review when none is approved). Asks only when
   * something in the batch is not approved yet. Returns how many commits it made.
   */
  const commitPlanned = async (target?: string): Promise<number> => {
    const model = controller.review;
    if (!model) {
      return 0;
    }
    let batch = model.commitBatch(target);
    if (batch.length === 0 && !target) {
      const current = model.currentCommit();
      if (!current) {
        void vscode.window.showInformationMessage('No commit is approved yet. Approve its files first.');
        return 0;
      }
      batch = model.commitBatch(current.id);
    }
    if (batch.length === 0) {
      void vscode.window.showInformationMessage('There is nothing to commit.');
      return 0;
    }
    // Hard problems (no files, a dependency that was reverted) stop here without asking anything.
    const before = new Set<string>();
    for (const commit of batch) {
      const blocker = model.commitBlocker(commit.id, before);
      if (blocker) {
        throw new Error(blocker);
      }
      before.add(commit.id);
    }
    const unapproved = batch.filter((c) => model.unapprovedCount(c.id) > 0);
    if (unapproved.length > 0) {
      const files = unapproved.reduce((sum, c) => sum + model.unapprovedCount(c.id), 0);
      const what = unapproved.length === 1 ? `"${label(unapproved[0]).replace(/^\d+\. /, '')}" has` : `${unapproved.length} commits have`;
      const choice = await vscode.window.showWarningMessage(
        `${what} ${files} file(s) not approved yet. Commit anyway?`,
        {
          modal: true,
          detail: batch.length > 1 ? `Commits, in order:\n${batch.map((c) => `${label(c)}${model.unapprovedCount(c.id) > 0 ? ' (not approved)' : ''}`).join('\n')}` : undefined,
        },
        'Commit anyway',
      );
      if (choice !== 'Commit anyway') {
        return 0;
      }
    }
    const previous = model.state.session.currentCommitId;
    const result = await controller.commitCommits(
      batch.map((c) => c.id),
      { allowUnapproved: unapproved.length > 0 },
    );
    const done = result.shas.length === 1 ? `Committed ${result.shas[0].slice(0, 7)}` : `Committed ${result.shas.length} commits`;
    void vscode.window.setStatusBarMessage(`$(git-commit) ${done}`, 5000);
    if (result.nextCommitId && result.nextCommitId !== previous) {
      await openNextTodo(controller);
    }
    return result.shas.length;
  };

  /** Pushes with VS Code's Git, which handles sign-in and publishing a new branch. */
  const push = async () => {
    await vscode.commands.executeCommand('git.push');
    await updateShipContext();
  };

  register('sift.commitApproved', async () => {
    await commitPlanned();
  });
  register('sift.commitApprovedAndPush', async () => {
    if ((await commitPlanned()) > 0) {
      await push();
    }
  });
  register('sift.push', push);

  /** The commit a commit action applies to: the clicked one, else the one picked from `candidates`. */
  const pickCommit = async (node: PlanNode | undefined, candidates: PlanCommit[], placeHolder: string, empty: string) => {
    const fromNode = commitIdOf(node);
    if (fromNode) {
      return fromNode;
    }
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(empty);
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: label(c), description: c.sha?.slice(0, 7), commitId: c.id })),
      { placeHolder },
    );
    return pick?.commitId;
  };

  register('sift.approveCommit', async (node?: PlanNode) => {
    const model = controller.review;
    if (!model) {
      return;
    }
    const pending = model.commitsInOrder().filter((c) => c.status !== 'committed');
    const commitId =
      commitIdOf(node) ?? model.state.session.currentCommitId ?? (await pickCommit(undefined, pending, 'Commit to make', 'Every commit is committed.'));
    if (commitId) {
      await commitPlanned(commitId);
    }
  });

  register('sift.setDependencies', async (node?: PlanNode) => {
    const model = controller.review;
    if (!model) {
      return;
    }
    const pending = model.commitsInOrder().filter((c) => c.status !== 'committed');
    const commitId = await pickCommit(node, pending, 'Commit whose dependencies to set', 'Every commit is committed.');
    if (!commitId) {
      return;
    }
    const commit = model.getCommit(commitId);
    const earlier = model.commitsInOrder().filter((c) => c.order < commit.order);
    if (earlier.length === 0) {
      void vscode.window.showInformationMessage(`"${commit.message.split('\n')[0]}" is the first commit: move it down to make it build on another one.`);
      return;
    }
    const current = new Set(commit.dependsOn ?? []);
    const picked = await vscode.window.showQuickPick(
      earlier.map((c) => ({
        label: label(c),
        description: c.status === 'committed' ? 'committed' : undefined,
        picked: current.has(c.id),
        commitId: c.id,
      })),
      {
        canPickMany: true,
        placeHolder: `Commits "${commit.message.split('\n')[0]}" builds on: it can't be committed or moved before them`,
      },
    );
    if (picked) {
      await controller.setDependencies(commitId, picked.map((p) => p.commitId));
    }
  });

  register('sift.undoCommit', async (node?: PlanNode) => {
    const model = controller.review;
    if (!model) {
      return;
    }
    const local = model.commitsInOrder().filter((c) => c.status === 'committed' && !c.pushed && !c.revertedBy);
    const commitId = await pickCommit(node, local, 'Commit to undo', 'No commit made in this review is waiting to be pushed.');
    if (!commitId) {
      return;
    }
    const commit = model.getCommit(commitId);
    // Undoing a commit undoes the ones made on top of it too: say so when there are any.
    const later = await controller.commitsUndoneWith(commitId);
    if (later.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `Undo "${commit.message.split('\n')[0]}" and the ${later.length} commit(s) made after it?`,
        {
          modal: true,
          detail: `Their changes go back to your working tree, uncommitted:\n${later.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n')}`,
        },
        'Undo commits',
      );
      if (choice !== 'Undo commits') {
        return;
      }
    }
    await controller.undoCommit(commitId);
    await comments.rerender();
    void vscode.window.setStatusBarMessage(`$(discard) Undid "${commit.message.split('\n')[0]}": its changes are back in the plan`, 5000);
  });

  register('sift.revertCommit', async (node?: PlanNode) => {
    const model = controller.review;
    if (!model) {
      return;
    }
    const revertible = model.commitsInOrder().filter((c) => c.status === 'committed' && !c.revertedBy);
    const commitId = await pickCommit(node, revertible, 'Commit to revert', 'No commit of this review can be reverted.');
    if (!commitId) {
      return;
    }
    const commit = model.getCommit(commitId);
    const waiting = model.dependentsOf(commitId).filter((c) => c.status !== 'committed');
    const choice = await vscode.window.showWarningMessage(
      `Revert "${commit.message.split('\n')[0]}"?`,
      {
        modal: true,
        detail: [
          'This makes a new commit that undoes its changes.',
          ...(waiting.length > 0 ? [`These planned commits build on it and can't be committed after the revert: ${waiting.map(label).join(', ')}.`] : []),
        ].join('\n\n'),
      },
      'Revert',
    );
    if (choice !== 'Revert') {
      return;
    }
    const sha = await controller.revertCommit(commitId);
    void vscode.window.setStatusBarMessage(`$(discard) Reverted with ${sha.slice(0, 7)}`, 5000);
  });

  register('sift.collapseAll', () => viewOptions.setCollapsed(true));
  register('sift.expandAll', () => viewOptions.setCollapsed(false));
  register('sift.viewAsTree', () => viewOptions.setAsTree(true));
  register('sift.viewAsList', () => viewOptions.setAsTree(false));
  register('sift.groupByStatus', () => viewOptions.setGroupByStatus(true));
  register('sift.ungroupByStatus', () => viewOptions.setGroupByStatus(false));
  register('sift.hideDone', () => viewOptions.setShowDone(false));
  register('sift.showDone', () => viewOptions.setShowDone(true));
  register('sift.hideCommitted', () => viewOptions.setShowCommitted(false));
  register('sift.showCommitted', () => viewOptions.setShowCommitted(true));

  /** Narrows the plan to the files whose path fuzzy-matches what is typed, as it is typed. */
  const filterFiles = async () => {
    const before = viewOptions.filter;
    const input = vscode.window.createInputBox();
    input.title = 'Filter files';
    input.placeholder = 'Part of a file name or path, e.g. "ctrl rev" finds src/controller/ReviewController.ts';
    input.value = before;
    let accepted = false;
    input.onDidChangeValue((value) => void viewOptions.setFilter(value));
    input.onDidAccept(() => {
      accepted = true;
      input.hide();
    });
    input.onDidHide(() => {
      if (!accepted) {
        void viewOptions.setFilter(before); // Escape: back to the filter as it was
      }
      input.dispose();
    });
    input.show();
  };
  register('sift.filterFiles', filterFiles);
  register('sift.editFilter', filterFiles);
  register('sift.clearFilter', () => viewOptions.setFilter(''));
  const updateFilterMessage = () => {
    planView.message = viewOptions.filter ? `Files matching "${viewOptions.filter}"` : undefined;
  };
  context.subscriptions.push(viewOptions.onDidChange(updateFilterMessage));

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
        const choice = await vscode.window.showWarningMessage(
          `Sift: the new plan in .sift/plan.json drops commits you already started reviewing: ${quoteList(outcome.lost)}. Apply it?`,
          'Apply',
          'Ignore',
        );
        if (choice === 'Apply') {
          await controller.loadPlan();
        } else if (choice === 'Ignore') {
          await controller.discardPlanFile();
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
    void vscode.commands.executeCommand('setContext', 'sift.readyToCommit', (controller.review?.commitBatch().length ?? 0) > 0);
    const upstream = await git.exec(['rev-list', '--count', '@{upstream}..HEAD'], { okCodes: [0, 128] }).catch(() => null);
    let unpushed = false;
    if (upstream?.exitCode === 0) {
      unpushed = Number(upstream.stdout.trim()) > 0;
    } else {
      // No upstream: worth publishing once Sift made a commit on this branch.
      unpushed = controller.review?.state.commits.some((c) => c.status === 'committed' && !c.pushed) ?? false;
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
    // Sift's diff menu shows only on Sift's own files, not on every diff editor.
    void vscode.commands.executeCommand('setContext', 'sift.activeFileInReview', Boolean(file));
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
function selectedPaths(controller: ReviewController, planTree: PlanTree, node?: TreeNode, selected?: TreeNode[]): string[] {
  const nodes = selected && selected.length > 0 ? selected : node ? [node] : [];
  const paths = [
    ...new Set(nodes.flatMap((n) => (n.kind === 'file' ? [n.path] : n.kind === 'dir' ? planTree.filesUnder(n) : []))),
  ];
  if (paths.length > 0 || nodes.some((n) => n.kind === 'dir')) {
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
