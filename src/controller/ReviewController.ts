import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { emptyOutcome, ReviewModel, type SyncOutcome } from '../core/ReviewModel';
import { ignorePaths, trackedPaths, type IgnoreTarget } from '../git/ignore';
import type { FileStatus, IterationAuthor, PlanInput, ReviewThread } from '../core/types';
import type { GitRunner } from '../git/GitRunner';
import { commitChanges, commitPaths, currentHead, fileDiff, hasStagedChanges, listChanges, operationInProgress } from '../git/changes';
import { blobHashes, inHeadHistory, lastTouches, readCommitRefs, setCommitRef } from '../git/history';
import { type SnapshotService, sessionRefPrefix, snapshotRef } from '../git/SnapshotService';
import { excludeStateDir, type StateStore } from '../state/StateStore';
import { SCHEME, snapshotUri } from '../ui/SnapshotContentProvider';

export type DiffMode = 'round' | 'cumulative';

/** What happened to .sift/plan.json when it was checked. */
export type PlanFileResult =
  | { result: 'none' }
  | { result: 'applied'; commits: number; unassigned: number; started: boolean }
  | { result: 'needs-confirm'; hash: string };

/**
 * Single owner of the review state. UI parts call its methods and re-render on `onDidChange`.
 */
export class ReviewController implements vscode.Disposable {
  private model: ReviewModel | null = null;
  /** What each git commit changed; commits never change, so this never goes stale. */
  private readonly commitChangesCache = new Map<string, Awaited<ReturnType<typeof commitChanges>>>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  diffMode: DiffMode = 'round';
  boardShowAll = false;

  constructor(
    readonly root: string,
    private readonly gitDir: string,
    private readonly git: GitRunner,
    private readonly snapshots: SnapshotService,
    private readonly store: StateStore,
    private readonly stateInRepo: boolean,
  ) {}

  get review(): ReviewModel | null {
    return this.model;
  }

  get statePath(): string {
    return this.store.filePath;
  }

  dispose(): void {
    this.changed.dispose();
  }

  /** Re-renders the UI after a view-only setting changed (diff mode, board scope). */
  async notify(): Promise<void> {
    await this.fire();
  }

  async init(): Promise<void> {
    await this.adopt(await this.store.load());
  }

  /** Picks up the saved state when something outside this window changed it. Returns true when it did. */
  async reloadState(): Promise<boolean> {
    const state = await this.store.loadIfChanged();
    if (state === undefined) {
      return false;
    }
    await this.adopt(state);
    return true;
  }

  /** Takes a loaded state, filling what git knows before anything is shown. */
  private async adopt(state: Awaited<ReturnType<StateStore['load']>>): Promise<void> {
    this.model = state ? new ReviewModel(state) : null;
    if (this.model) {
      await this.sync(this.model).catch(() => undefined);
    }
    await this.fire();
  }

  // ---- session ----

  /** Starts a session from the uncommitted changes when there is none yet. Returns true when it started one. */
  async ensureSession(): Promise<boolean> {
    if (this.model) {
      return false;
    }
    await this.startReview();
    return true;
  }

  async startReview(): Promise<number> {
    if (this.model) {
      throw new Error('A review session already exists. Abort it first to start over.');
    }
    const operation = await operationInProgress(this.git);
    if (operation) {
      throw new Error(`Finish ${operation} before starting a review.`);
    }
    if (await hasStagedChanges(this.git)) {
      throw new Error('The index has staged changes. Unstage them (git restore --staged .) before starting.');
    }
    const head = await currentHead(this.git);
    const changes = await listChanges(this.git);
    if (changes.length === 0) {
      throw new Error('There are no uncommitted changes to review.');
    }

    if (this.stateInRepo) {
      await excludeStateDir(this.gitDir);
    }
    this.model = ReviewModel.create(newSessionId(), head, changes, new Date().toISOString());
    this.model.state.session.planFileHash = '';
    await this.persist();
    return changes.length;
  }

  /**
   * Re-reads the working tree. When HEAD moved (commits made outside Sift), takes the new HEAD and
   * marks planned commits whose files were committed as done, so the plan never shows empty commits.
   */
  async refresh(): Promise<SyncOutcome> {
    const model = this.require();
    const before = JSON.stringify(model.state);
    const outcome = await this.sync(model);
    // Builds and other tools touch files all the time. Redrawing the views for nothing would
    // swallow clicks that land mid-redraw, so only save and redraw when something changed.
    if (JSON.stringify(model.state) !== before) {
      await this.persist();
    }
    return outcome;
  }

  /**
   * Reads what git knows (changed files, which planned commits are in HEAD's history, the content
   * of approved files) and lets the model settle the review on it. See ReviewModel.sync.
   */
  private async sync(model: ReviewModel): Promise<SyncOutcome> {
    if (await operationInProgress(this.git)) {
      // Mid-rebase or merge the working tree is temporary: keep the plan as it is until git is done.
      return emptyOutcome();
    }
    const sessionId = model.state.session.id;
    const refs = await readCommitRefs(this.git, sessionId);
    // Sessions saved before commit refs existed kept the sha in the state: record it once.
    for (const commit of model.state.commits) {
      if (commit.status === 'committed' && commit.sha && !refs.has(commit.id)) {
        await setCommitRef(this.git, sessionId, commit.id, commit.sha);
        refs.set(commit.id, commit.sha);
      }
    }
    const inHistory = new Map<string, string>();
    for (const [commitId, sha] of refs) {
      if (model.state.commits.some((c) => c.id === commitId) && (await inHeadHistory(this.git, sha))) {
        inHistory.set(commitId, sha);
      }
    }
    const changes = await listChanges(this.git);
    const changedPaths = new Set(changes.map((c) => c.path));
    const lastTouch = await lastTouches(this.git, model.state.session.baseCommit, model.pathsToTrace(changedPaths, inHistory));
    const blobs = await blobHashes(this.git, model.approvedPaths().filter((p) => changedPaths.has(p)));

    const outcome = model.sync({ changes, inHistory, lastTouch, blobs });
    for (const [commitId, sha] of outcome.refs) {
      await setCommitRef(this.git, sessionId, commitId, sha);
    }
    for (const commit of model.state.commits) {
      if (commit.status === 'committed' && commit.sha) {
        let changed = this.commitChangesCache.get(commit.sha);
        if (!changed) {
          changed = await commitChanges(this.git, commit.sha);
          this.commitChangesCache.set(commit.sha, changed);
        }
        model.fillCommitted(commit.id, changed);
      }
    }
    return outcome;
  }

  /** Git-tracked files among `paths`: adding them to an ignore file would not hide their changes. */
  async trackedPaths(paths: string[]): Promise<string[]> {
    return trackedPaths(this.git, paths);
  }

  /** Adds the files to .gitignore or .git/info/exclude, then drops them from the review. Returns the ignore file. */
  async ignoreFiles(paths: string[], target: IgnoreTarget): Promise<string> {
    const file = await ignorePaths(this.git, paths, target);
    await this.refresh();
    return file;
  }

  async abort(): Promise<void> {
    const model = this.require();
    await this.snapshots.deleteRefs(sessionRefPrefix(model.state.session.id));
    await this.store.remove();
    // A leftover plan file would otherwise start a new session on the next load.
    await fs.rm(this.planFilePath(), { force: true });
    this.model = null;
    await this.fire();
  }

  // ---- plan ----

  planFilePath(): string {
    return path.join(this.root, '.sift', 'plan.json');
  }

  async loadPlan(): Promise<{ commits: number; unassigned: number }> {
    const raw = await fs.readFile(this.planFilePath(), 'utf8').catch(() => {
      throw new Error(`No plan found at ${this.planFilePath()}.`);
    });
    await this.ensureSession();
    const result = await this.applyPlanInput(parsePlan(raw), false);
    this.require().state.session.planFileHash = hashOf(raw);
    await this.persist();
    return result;
  }

  /**
   * Picks up .sift/plan.json when it is new: applies it right away (starting a session if needed),
   * or asks first when it would replace a plan that is already under review.
   */
  async checkPlanFile(): Promise<PlanFileResult> {
    const raw = await fs.readFile(this.planFilePath(), 'utf8').catch(() => null);
    if (raw === null || !raw.trim()) {
      return { result: 'none' };
    }
    const hash = hashOf(raw);
    if (this.model?.state.session.planFileHash === hash) {
      return { result: 'none' };
    }
    if (this.model && this.model.state.session.planFileHash === undefined) {
      // Session from before plan files were tracked: its plan.json was already loaded by hand.
      this.model.state.session.planFileHash = hash;
      await this.persist();
      return { result: 'none' };
    }
    if (this.model && this.model.state.commits.some((c) => c.status !== 'committed')) {
      return { result: 'needs-confirm', hash };
    }
    const started = await this.ensureSession();
    const result = await this.applyPlanInput(parsePlan(raw), false);
    this.require().state.session.planFileHash = hash;
    await this.persist();
    return { result: 'applied', ...result, started };
  }

  /** Remembers a plan file the user chose not to load, so it isn't offered again. */
  async dismissPlanFile(hash: string): Promise<void> {
    if (this.model) {
      this.model.state.session.planFileHash = hash;
      await this.persist();
    }
  }

  async newCommit(message: string): Promise<string> {
    const commit = this.require().addCommit(message);
    await this.persist();
    return commit.id;
  }

  async renameCommit(commitId: string, message: string): Promise<void> {
    this.require().renameCommit(commitId, message);
    await this.persist();
  }

  async deleteCommit(commitId: string): Promise<void> {
    this.require().deleteCommit(commitId);
    await this.persist();
  }

  async moveCommit(commitId: string, delta: -1 | 1): Promise<void> {
    this.require().moveCommit(commitId, delta);
    await this.persist();
  }

  async moveFiles(paths: string[], commitId: string | null): Promise<void> {
    this.require().moveFiles(paths, commitId);
    await this.persist();
  }

  // ---- review loop ----

  async startCommit(commitId: string): Promise<void> {
    const model = this.require();
    model.startCommit(commitId);
    if (!model.latestIteration(commitId)) {
      await this.snapshot(commitId, 'initial', true);
    }
    await this.persist();
  }

  /** Freezes the working tree as the next round. Returns the new version number, or null if nothing changed. */
  async takeSnapshot(author: IterationAuthor): Promise<number | null> {
    const model = this.require();
    const commit = model.currentCommit();
    if (!commit) {
      throw new Error('Start reviewing a commit first.');
    }
    const n = await this.snapshot(commit.id, author, false);
    await this.persist();
    return n;
  }

  async setStatus(paths: string[], status: FileStatus): Promise<void> {
    // An approval covers the content as it is now; editing the file later takes it back.
    const blobs = status === 'done' ? await blobHashes(this.git, paths) : undefined;
    this.require().setStatus(paths, status, blobs);
    await this.persist();
  }

  async approveCurrent(): Promise<{ sha: string; nextCommitId: string | null }> {
    const model = this.require();
    // Catch up with git first: commits made outside Sift, files changed since they were approved.
    const outcome = await this.sync(model);
    const commit = model.currentCommit();
    if (!commit) {
      await this.persist();
      throw new Error(
        outcome.committedOutside.length > 0 ? 'This commit was already committed outside Sift.' : 'No commit is in review.',
      );
    }
    const blocker = model.approvalBlocker(commit.id);
    if (blocker) {
      await this.persist();
      throw new Error(outcome.unapproved.length > 0 ? `${blocker} Some changed after you approved them.` : blocker);
    }

    const paths = model.filesOf(commit.id).map((f) => f.path);
    const sha = await commitPaths(this.git, paths, commit.message);
    await setCommitRef(this.git, model.state.session.id, commit.id, sha);
    model.markCommitted(commit.id, sha);
    await this.sync(model);
    const next = model.commitsInOrder().find((c) => c.status !== 'committed') ?? null;
    if (next) {
      model.startCommit(next.id);
      if (!model.latestIteration(next.id)) {
        await this.snapshot(next.id, 'initial', true);
      }
    }
    await this.persist();
    return { sha, nextCommitId: next?.id ?? null };
  }

  // ---- plan from the AI ----

  /** Plan from the AI: every pending file must be listed exactly once. Starts a session if needed. */
  async setPlan(plan: PlanInput, model?: string): Promise<void> {
    await this.ensureSession();
    await this.applyPlanInput(plan, true, model);
    await this.persist();
  }

  /** Applies a plan and its explanations; the caller persists. */
  private async applyPlanInput(
    plan: PlanInput,
    requireAll: boolean,
    model?: string,
  ): Promise<{ commits: number; unassigned: number }> {
    const review = this.require();
    await this.sync(review);
    const { unassigned } = review.applyPlan(plan, requireAll);
    const now = new Date().toISOString();
    for (const commit of plan.commits) {
      for (const note of commit.explanations ?? []) {
        const lines = await this.readLines(note.path);
        const index = Math.min(Math.max(note.line - 1, 0), Math.max(lines.length - 1, 0));
        review.setExplanation(note.path, index, lines[index] ?? '', note.body, now, model);
      }
    }
    return { commits: plan.commits.length, unassigned };
  }

  // ---- comments ----

  async addComment(filePath: string, line: number, lineText: string, body: string): Promise<ReviewThread> {
    const thread = this.require().addThread(
      { kind: 'comment', path: filePath, line, lineText, body, author: 'user' },
      new Date().toISOString(),
    );
    await this.persist();
    return thread;
  }

  async replyAsUser(threadId: string, body: string): Promise<void> {
    this.require().reply(threadId, 'user', body, false, new Date().toISOString());
    await this.persist();
  }

  async replyAsAi(threadId: string, body: string, model: string, resolve = false): Promise<ReviewThread> {
    const thread = this.require().reply(threadId, 'ai', body, resolve, new Date().toISOString(), model);
    await this.persist();
    return thread;
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    this.require().setThreadResolved(threadId, resolved);
    await this.persist();
  }

  async editMessage(threadId: string, index: number, body: string): Promise<void> {
    this.require().editMessage(threadId, index, body);
    await this.persist();
  }

  async deleteMessage(threadId: string, index: number): Promise<void> {
    this.require().deleteMessage(threadId, index);
    await this.persist();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.require().deleteThread(threadId);
    await this.persist();
  }

  /** An AI explanation on a 1-based line of a file, anchored to that line's current text. */
  async explain(filePath: string, line: number, body: string): Promise<ReviewThread> {
    const lines = await this.readLines(filePath);
    const index = Math.min(Math.max(line - 1, 0), Math.max(lines.length - 1, 0));
    const thread = this.require().setExplanation(filePath, index, lines[index] ?? '', body, new Date().toISOString());
    await this.persist();
    return thread;
  }

  async setShowExplanations(show: boolean): Promise<void> {
    this.require().setShowExplanations(show);
    await this.persist();
  }

  // ---- asking the AI ----

  /** Marks the given threads (or every open comment) as being answered. Returns them. */
  async startAsking(threadIds?: string[]): Promise<ReviewThread[]> {
    const threads = this.require().startAsking(threadIds);
    await this.persist();
    return threads;
  }

  async failAsking(threadId: string, error: string): Promise<void> {
    if (!this.model?.state.threads.some((t) => t.id === threadId)) {
      return;
    }
    this.model.failAsking(threadId, error);
    await this.persist();
  }

  // ---- diffs ----

  /**
   * Opens the diff of a file: by the diff mode, or `compare.from` (a version or HEAD) against
   * `compare.to` (a version, or the working tree when left out).
   */
  async openDiff(filePath: string, compare?: { from: number | 'HEAD'; to?: number }): Promise<void> {
    const model = this.require();
    const file = model.findFile(filePath);
    if (!file) {
      throw new Error(`${filePath} is not part of this review.`);
    }

    const name = path.basename(filePath);
    const workingTree = file.changeType === 'deleted' ? snapshotUri('empty', filePath) : this.fileUri(filePath);
    const iterations = file.commitId ? model.iterationsOf(file.commitId) : [];
    const latest = iterations.at(-1);
    const previous = iterations.at(-2);

    let left = snapshotUri('HEAD', filePath);
    let right = workingTree;
    let title = `${name} (HEAD ↔ working tree)`;

    if (compare) {
      const from = compare.from === 'HEAD' ? null : iterations.find((i) => i.n === compare.from);
      const to = compare.to === undefined ? null : iterations.find((i) => i.n === compare.to);
      if (from === undefined || to === undefined) {
        throw new Error('Unknown version.');
      }
      left = from ? snapshotUri(from.treeSha, filePath) : snapshotUri('HEAD', filePath);
      right = to ? snapshotUri(to.treeSha, filePath) : workingTree;
      title = `${name} (${from ? `v${from.n}` : 'HEAD'} ↔ ${to ? `v${to.n}` : 'now'})`;
    } else if (this.diffMode === 'round' && latest && previous) {
      left = snapshotUri(previous.treeSha, filePath);
      title = `${name} (v${previous.n} ↔ v${latest.n} · this round)`;
    } else if (latest) {
      title = `${name} (HEAD ↔ v${latest.n} · cumulative)`;
    }

    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    if (model.markOpened(filePath)) {
      await this.persist();
    }
  }

  /** Path of the file shown in the active editor, when it belongs to the review. */
  activeFilePath(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? this.reviewPath(uri) : null;
  }

  /** Repo-relative path of a working-tree or snapshot URI, when that file belongs to the review. */
  reviewPath(uri: vscode.Uri): string | null {
    if (!this.model) {
      return null;
    }
    let candidate: string | null = null;
    if (uri.scheme === 'file') {
      const relative = path.relative(this.root, uri.fsPath);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        candidate = relative.split(path.sep).join('/');
      }
    } else if (uri.scheme === SCHEME) {
      candidate = uri.path.replace(/^\//, '');
    }
    if (!candidate || !this.model.findFile(candidate)) {
      return null;
    }
    return candidate;
  }

  // ---- internals ----

  private async snapshot(commitId: string, author: IterationAuthor, force: boolean): Promise<number | null> {
    const model = this.require();
    const previous = model.latestIteration(commitId);
    const tree = await this.snapshots.writeWorkingTree();
    if (previous && previous.treeSha === tree && !force) {
      return null;
    }
    if (previous && previous.treeSha === tree) {
      return previous.n;
    }

    const n = model.nextIterationNumber(commitId);
    const sessionId = model.state.session.id;
    const snapshot = await this.snapshots.store(tree, snapshotRef(sessionId, commitId, n), `sift ${commitId} v${n}`);
    model.addIteration({
      n,
      commitId,
      treeSha: snapshot.treeSha,
      commitSha: snapshot.commitSha,
      ref: snapshot.ref,
      author,
      createdAt: new Date().toISOString(),
    });

    if (previous) {
      model.applyRoundChanges(await this.snapshots.changedPaths(previous.treeSha, tree), n);
    }
    await this.sync(model);
    return n;
  }

  /** Unified diff of a file against HEAD. */
  async diffOf(filePath: string): Promise<string> {
    return fileDiff(this.git, filePath);
  }

  async readLines(filePath: string): Promise<string[]> {
    const content = await fs.readFile(path.join(this.root, ...filePath.split('/')), 'utf8').catch(() => '');
    return content.split(/\r?\n/);
  }

  private fileUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, ...filePath.split('/')));
  }

  private require(): ReviewModel {
    if (!this.model) {
      throw new Error('No review session. Click "Plan commits with AI" or "Start review" first.');
    }
    return this.model;
  }

  private async persist(): Promise<void> {
    if (this.model) {
      await this.store.save(this.model.state);
    }
    await this.fire();
  }

  private async fire(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'sift.active', this.model !== null);
    this.changed.fire();
  }
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function parsePlan(raw: string): PlanInput {
  try {
    return JSON.parse(raw) as PlanInput;
  } catch (error) {
    throw new Error(`.sift/plan.json is not valid JSON: ${(error as Error).message}`);
  }
}

function newSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `s_${date}_${randomBytes(3).toString('hex')}`;
}
