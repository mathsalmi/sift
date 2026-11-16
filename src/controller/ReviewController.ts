import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ReviewModel } from '../core/ReviewModel';
import type { FileStatus, IterationAuthor, PendingApproval, PlanInput, ReviewThread } from '../core/types';
import type { GitRunner } from '../git/GitRunner';
import { commitPaths, currentHead, hasStagedChanges, listChanges, operationInProgress } from '../git/changes';
import { type SnapshotService, sessionRefPrefix, snapshotRef } from '../git/SnapshotService';
import { excludeStateDir, type StateStore } from '../state/StateStore';
import { SCHEME, snapshotUri } from '../ui/SnapshotContentProvider';

export type DiffMode = 'round' | 'cumulative';

export type FeedbackEvent =
  | { event: 'feedback'; commitId: string; threads: ReviewThread[] }
  | { event: 'approved'; approval: PendingApproval }
  | { event: 'none' };

type Waiter = () => void;

/**
 * Single owner of the review state. UI parts call its methods and re-render on `onDidChange`.
 */
export class ReviewController implements vscode.Disposable {
  private model: ReviewModel | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  diffMode: DiffMode = 'round';
  boardShowAll = false;
  private waiters: Waiter[] = [];

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

  /** True while Claude is blocked in review_wait_for_feedback. */
  get claudeIsWaiting(): boolean {
    return this.waiters.length > 0;
  }

  dispose(): void {
    this.wakeWaiters();
    this.changed.dispose();
  }

  /** Re-renders the UI after a view-only setting changed (diff mode, board scope). */
  async notify(): Promise<void> {
    await this.fire();
  }

  async init(): Promise<void> {
    const state = await this.store.load();
    this.model = state ? new ReviewModel(state) : null;
    await this.fire();
  }

  // ---- session ----

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
    await this.persist();
    return changes.length;
  }

  async refresh(): Promise<void> {
    const model = this.require();
    model.syncChanges(await listChanges(this.git));
    await this.persist();
  }

  async abort(): Promise<void> {
    const model = this.require();
    await this.snapshots.deleteRefs(sessionRefPrefix(model.state.session.id));
    await this.store.remove();
    this.model = null;
    this.wakeWaiters();
    await this.fire();
  }

  // ---- plan ----

  planFilePath(): string {
    return path.join(this.root, '.sift', 'plan.json');
  }

  async loadPlan(): Promise<{ commits: number; unassigned: number }> {
    const model = this.require();
    const raw = await fs.readFile(this.planFilePath(), 'utf8').catch(() => {
      throw new Error(`No plan found at ${this.planFilePath()}.`);
    });
    const plan = JSON.parse(raw) as PlanInput;
    model.syncChanges(await listChanges(this.git));
    const result = model.applyPlan(plan);
    await this.persist();
    return { commits: plan.commits.length, unassigned: result.unassigned };
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
    this.require().setStatus(paths, status);
    await this.persist();
  }

  async approveCurrent(): Promise<{ sha: string; nextCommitId: string | null }> {
    const model = this.require();
    const commit = model.currentCommit();
    if (!commit) {
      throw new Error('No commit is in review.');
    }
    const blocker = model.approvalBlocker(commit.id);
    if (blocker) {
      throw new Error(blocker);
    }
    const head = await currentHead(this.git);
    if (head !== model.state.session.lastHead) {
      throw new Error('HEAD moved outside Sift. Run "Refresh changes" to re-sync, then approve again.');
    }

    const paths = model.filesOf(commit.id).map((f) => f.path);
    const sha = await commitPaths(this.git, paths, commit.message);
    const next = model.markCommitted(commit.id, sha);
    model.syncChanges(await listChanges(this.git));
    if (next) {
      model.startCommit(next.id);
      if (!model.latestIteration(next.id)) {
        await this.snapshot(next.id, 'initial', true);
      }
    }
    await this.persist();
    this.wakeWaiters();
    return { sha, nextCommitId: next?.id ?? null };
  }

  /** Accepts the current HEAD after a commit made outside the extension. */
  async resyncHead(): Promise<void> {
    const model = this.require();
    model.setHead(await currentHead(this.git));
    model.syncChanges(await listChanges(this.git));
    await this.persist();
  }

  async headMovedOutside(): Promise<boolean> {
    if (!this.model) {
      return false;
    }
    return (await currentHead(this.git)) !== this.model.state.session.lastHead;
  }

  // ---- plan from Claude ----

  /** Plan from Claude: every pending file must be listed exactly once. */
  async setPlan(plan: PlanInput): Promise<void> {
    const model = this.require();
    model.syncChanges(await listChanges(this.git));
    model.applyPlan(plan, true);
    await this.persist();
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

  async replyAsClaude(threadId: string, body: string, resolve: boolean): Promise<ReviewThread> {
    const thread = this.require().reply(threadId, 'claude', body, resolve, new Date().toISOString());
    await this.persist();
    return thread;
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    this.require().setThreadResolved(threadId, resolved);
    await this.persist();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.require().deleteThread(threadId);
    await this.persist();
  }

  /** Claude's explanation on a 1-based line of a file, anchored to that line's current text. */
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

  // ---- the loop with Claude ----

  async sendToClaude(): Promise<number> {
    const model = this.require();
    const commit = model.currentCommit();
    if (!commit) {
      throw new Error('Start reviewing a commit first.');
    }
    const count = model.sendFeedback(commit.id);
    await this.persist();
    this.wakeWaiters();
    return count;
  }

  /** Claude finished applying feedback: snapshot the next round and hand the turn back. */
  async markReady(): Promise<number | null> {
    const model = this.require();
    const commit = model.currentCommit();
    if (!commit) {
      throw new Error('No commit is in review.');
    }
    const n = await this.snapshot(commit.id, 'claude', false);
    model.finishClaudeTurn(commit.id);
    await this.persist();
    return n;
  }

  /** Clears and returns the approval Claude hasn't seen yet. */
  async takeApproval(): Promise<PendingApproval | null> {
    const approval = this.require().takePendingApproval();
    await this.persist();
    return approval;
  }

  /** What Claude should act on now, without waiting. */
  pendingEvent(): FeedbackEvent {
    const model = this.model;
    if (!model) {
      return { event: 'none' };
    }
    const approval = model.state.session.pendingApproval;
    if (approval) {
      return { event: 'approved', approval };
    }
    const commit = model.currentCommit();
    if (commit && model.state.session.turn === 'claude') {
      const threads = model.sentThreads(commit.id);
      if (threads.length > 0) {
        return { event: 'feedback', commitId: commit.id, threads };
      }
    }
    return { event: 'none' };
  }

  /** Resolves when the user sends feedback or approves, or with "none" on timeout or cancel. */
  async waitForFeedback(timeoutMs: number, signal?: AbortSignal): Promise<FeedbackEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const event = this.pendingEvent();
      if (event.event !== 'none') {
        return event;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted || !this.model) {
        return { event: 'none' };
      }
      const wasWaiting = this.claudeIsWaiting;
      const sleep = this.sleepUntilWoken(remaining, signal);
      if (!wasWaiting) {
        this.changed.fire();
      }
      await sleep;
      if (!this.claudeIsWaiting) {
        this.changed.fire();
      }
    }
  }

  // ---- diffs ----

  async openDiff(filePath: string, compare?: { from: number; to: number }): Promise<void> {
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
      const from = iterations.find((i) => i.n === compare.from);
      const to = iterations.find((i) => i.n === compare.to);
      if (!from || !to) {
        throw new Error('Unknown version.');
      }
      left = snapshotUri(from.treeSha, filePath);
      right = snapshotUri(to.treeSha, filePath);
      title = `${name} (v${from.n} ↔ v${to.n})`;
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
    if (!uri || !this.model) {
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
    model.syncChanges(await listChanges(this.git));
    return n;
  }

  private sleepUntilWoken(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done);
      this.waiters.push(done);
    });
  }

  private wakeWaiters(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }

  private async readLines(filePath: string): Promise<string[]> {
    const content = await fs.readFile(path.join(this.root, ...filePath.split('/')), 'utf8').catch(() => '');
    return content.split(/\r?\n/);
  }

  private fileUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, ...filePath.split('/')));
  }

  private require(): ReviewModel {
    if (!this.model) {
      throw new Error('No review session. Run "Sift: Start review" first.');
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

function newSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `s_${date}_${randomBytes(3).toString('hex')}`;
}
