import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { approvalKey, emptyOutcome, planSplitPaths, ReviewModel, subjectOf, type SyncOutcome } from '../core/ReviewModel';
import { excludedEntries, ignorePaths, trackedPaths, unexcludePatterns, type ExcludeEntry, type IgnoreTarget } from '../git/ignore';
import type { FileRef, FileStatus, IterationAuthor, PlanCommit, PlanInput, ReviewFile, ReviewThread } from '../core/types';
import type { GitRunner } from '../git/GitRunner';
import {
  amendInto,
  branchStatus,
  commitChanges,
  commitEntries,
  currentHead,
  discardEntries,
  fileDiff,
  listChanges,
  operationInProgress,
  type BranchStatus,
  type StageEntry,
} from '../git/changes';
import { applyHunks, fileHunks, headText, hunkSignature, type Hunk } from '../git/hunks';
import {
  blobHashes,
  commitsAfter,
  DELETED_BLOB,
  hasBlob,
  inHeadHistory,
  isPushed,
  keepBlobs,
  lastTouches,
  readCommitRefs,
  revertCommit,
  setCommitRef,
  undoCommits,
} from '../git/history';
import { type SnapshotService, sessionRefPrefix, snapshotRef } from '../git/SnapshotService';
import { excludeStateDir, StaleStateError, type StateStore } from '../state/StateStore';
import { partQuery, parsePartQuery, SCHEME, snapshotUri } from '../ui/SnapshotContentProvider';

export type DiffMode = 'round' | 'cumulative';

/** What happened to .sift/plan.json when it was checked. */
export type PlanFileResult =
  | { result: 'none' }
  | { result: 'applied'; commits: number; unassigned: number; started: boolean }
  | { result: 'needs-confirm'; lost: string[] };

/**
 * Single owner of the review state. UI parts call its methods and re-render on `onDidChange`.
 */
export class ReviewController implements vscode.Disposable {
  private model: ReviewModel | null = null;
  /** What each git commit changed; commits never change, so this never goes stale. */
  private readonly commitChangesCache = new Map<string, Awaited<ReturnType<typeof commitChanges>>>();
  /** Commits a remote branch has; once pushed, a commit stays pushed. */
  private readonly pushedCache = new Set<string>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  diffMode: DiffMode = 'round';

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

  /** Re-renders the UI after a view-only setting changed (diff mode). */
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
    this.excluded = await excludedEntries(this.git).catch(() => []);
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
    const hunks = new Map<string, Hunk[]>();
    for (const filePath of model.hunkPaths()) {
      const change = changes.find((c) => c.path === filePath);
      if (change && change.changeType === 'modified' && !change.binary) {
        hunks.set(filePath, await fileHunks(this.git, filePath));
      }
    }

    const outcome = model.sync({ changes, inHistory, lastTouch, blobs, hunks });
    for (const iteration of model.missingChanges()) {
      const previous = model.iterationsOf(iteration.commitId).filter((i) => i.n < iteration.n).at(-1);
      iteration.changed = previous ? await this.snapshots.changedPaths(previous.treeSha, iteration.treeSha) : [];
    }
    for (const [commitId, sha] of outcome.refs) {
      await setCommitRef(this.git, sessionId, commitId, sha);
    }
    const reverts = await readCommitRefs(this.git, sessionId, 'revert');
    for (const commit of model.state.commits) {
      const revert = commit.status === 'committed' ? reverts.get(commit.id) : undefined;
      commit.revertedBy = revert && (await inHeadHistory(this.git, revert)) ? revert : undefined;
      if (revert && !commit.revertedBy) {
        await setCommitRef(this.git, sessionId, commit.id, null, 'revert'); // the revert was undone
      }
      commit.pushed = commit.status === 'committed' && commit.sha ? await this.isPushed(commit.sha) : undefined;
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

  private async isPushed(sha: string): Promise<boolean> {
    if (this.pushedCache.has(sha)) {
      return true;
    }
    const pushed = await isPushed(this.git, sha);
    if (pushed) {
      this.pushedCache.add(sha);
    }
    return pushed;
  }

  /** Git-tracked files among `paths`: adding them to an ignore file would not hide their changes. */
  /** The rules in .git/info/exclude, shown in the plan as "Locally excluded". */
  excluded: ExcludeEntry[] = [];

  /** Re-reads .git/info/exclude and redraws when its rules changed. */
  async loadExcluded(): Promise<void> {
    const entries = await excludedEntries(this.git).catch(() => []);
    if (JSON.stringify(entries) === JSON.stringify(this.excluded)) {
      return;
    }
    this.excluded = entries;
    await this.fire();
  }

  /** Removes rules from .git/info/exclude; their files come back into the review as changes. */
  async unexclude(patterns: string[]): Promise<void> {
    await unexcludePatterns(this.git, patterns);
    await this.loadExcluded();
    if (this.model) {
      await this.refresh();
    }
  }

  async trackedPaths(paths: string[]): Promise<string[]> {
    return trackedPaths(this.git, paths);
  }

  /** Adds the files to .gitignore or .git/info/exclude, then drops them from the review. Returns the ignore file. */
  async ignoreFiles(paths: string[], target: IgnoreTarget, dirs: string[] = []): Promise<string> {
    const file = await ignorePaths(this.git, paths, target, dirs);
    await this.loadExcluded();
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

  /**
   * Applies .sift/plan.json and deletes it: the file is only a way in for plans from other tools,
   * the plan itself lives in the state.
   */
  async loadPlan(): Promise<{ commits: number; unassigned: number }> {
    const raw = await fs.readFile(this.planFilePath(), 'utf8').catch(() => {
      throw new Error(`No plan found at ${this.planFilePath()}.`);
    });
    await this.ensureSession();
    const result = await this.applyPlanInput(parsePlan(raw), false);
    await this.persist();
    await this.discardPlanFile();
    return result;
  }

  /**
   * Picks up .sift/plan.json: applies it right away (starting a session if needed) and deletes it,
   * or asks first when it would drop commits already under review. A plan that fails stays, to be fixed.
   */
  async checkPlanFile(): Promise<PlanFileResult> {
    const raw = await fs.readFile(this.planFilePath(), 'utf8').catch(() => null);
    if (raw === null) {
      return { result: 'none' };
    }
    if (!raw.trim() || (await this.wasAppliedBefore(raw))) {
      await this.discardPlanFile();
      return { result: 'none' };
    }
    const plan = parsePlan(raw);
    // Commits the plan keeps (same message, or most of the same files) keep their review,
    // so only dropping reviewed work needs a yes.
    const lost = this.model?.reviewLostByPlan(plan) ?? [];
    if (lost.length > 0) {
      return { result: 'needs-confirm', lost };
    }
    const started = await this.ensureSession();
    const result = await this.applyPlanInput(plan, false);
    await this.persist();
    await this.discardPlanFile();
    return { result: 'applied', ...result, started };
  }

  /** Deletes .sift/plan.json (after applying it, or when the user chose not to). */
  async discardPlanFile(): Promise<void> {
    await fs.rm(this.planFilePath(), { force: true });
  }

  /**
   * Sessions from before plan files were deleted once applied remember the last one's hash:
   * a plan file with that hash was already applied. The hash is dropped once checked.
   */
  private async wasAppliedBefore(raw: string): Promise<boolean> {
    const session = this.model?.state.session as { planFileHash?: string } | undefined;
    if (!session || session.planFileHash === undefined) {
      return false;
    }
    const applied = session.planFileHash === hashOf(raw);
    delete session.planFileHash;
    await this.persist();
    return applied;
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

  async setDependencies(commitId: string, dependencyIds: string[]): Promise<void> {
    this.require().setDependencies(commitId, dependencyIds);
    await this.persist();
  }

  /** A path moves the whole file; a reference with a commit moves the file's part in that commit. */
  async moveFiles(refs: Array<string | FileRef>, commitId: string | null): Promise<void> {
    this.require().moveFiles(refs, commitId);
    await this.sync(this.require());
    await this.persist();
  }

  /** The file's blocks of changes against HEAD (empty for new, deleted and binary files). */
  async hunksOf(filePath: string): Promise<Hunk[]> {
    const file = this.model?.findFile(filePath);
    if (!file || file.binary || file.changeType !== 'modified') {
      return [];
    }
    return fileHunks(this.git, filePath);
  }

  /** The blocks of changes a file's entry (or part, for split files) holds. */
  async ownHunks(file: ReviewFile): Promise<Hunk[]> {
    const all = await this.hunksOf(file.path);
    const own = new Set(this.require().ownKeys(file, all.map((h) => h.key)));
    return all.filter((h) => own.has(h.key));
  }

  /** Moves some blocks of a file's changes to another commit, splitting the file across both. */
  async moveHunks(filePath: string, from: string | null, keys: string[], to: string | null): Promise<void> {
    const model = this.require();
    model.moveHunks(filePath, from, keys, to, await fileHunks(this.git, filePath));
    await this.sync(model);
    await this.persist();
  }

  /**
   * A file's text with or without the changes its part in `commitId` holds: with them (`own`) it is
   * what committing the part puts in the commit; without them, the other side of the part's diff.
   */
  async partText(filePath: string, commitId: string | null, own: boolean): Promise<string> {
    const model = this.require();
    const file = model.findFile(filePath, commitId);
    const base = (await headText(this.git, filePath)) ?? '';
    if (!file) {
      return base;
    }
    const all = await fileHunks(this.git, filePath);
    const keys = new Set(model.ownKeys(file, all.map((h) => h.key)));
    return applyHunks(
      base,
      all.filter((h) => keys.has(h.key) === own),
    );
  }

  /** What committing (or amending) these entries stages: whole files, or the content of their part. */
  private async stageEntriesOf(files: ReviewFile[]): Promise<StageEntry[]> {
    const model = this.require();
    const entries: StageEntry[] = [];
    for (const file of files) {
      entries.push(
        model.isSplit(file.path)
          ? { path: file.path, content: await this.partText(file.path, file.commitId, true) }
          : { path: file.path },
      );
    }
    return entries;
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

  /**
   * Freezes the working tree as the next round, giving a new version to the commit's files that changed.
   * Returns the snapshot number, or null when no file of the commit changed.
   */
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

  async setStatus(refs: Array<string | FileRef>, status: FileStatus): Promise<void> {
    // An approval covers the content as it is now; editing the file later takes it back. For a part
    // of a split file, it covers the part's own changes.
    const model = this.require();
    let approvals: Map<string, string> | undefined;
    if (status === 'done') {
      const files = refs.map((r) => model.resolve(r)).filter((f): f is ReviewFile => f !== undefined);
      const whole = files.filter((f) => !model.isSplit(f.path)).map((f) => f.path);
      approvals = await blobHashes(this.git, whole, true);
      await keepBlobs(this.git, model.state.session.id, approvals.values());
      for (const file of files.filter((f) => model.isSplit(f.path))) {
        approvals.set(approvalKey(file), hunkSignature((await this.ownHunks(file)).map((h) => h.key)));
      }
    }
    model.setStatus(refs, status, approvals);
    await this.persist();
  }

  /**
   * Commits the planned commits, in the order given (each one's dependencies first). Commits with
   * files not approved yet are refused unless `allowUnapproved`. When the commit in review was
   * committed, the next planned commit goes into review.
   */
  async commitCommits(
    commitIds: string[],
    options: { allowUnapproved?: boolean } = {},
  ): Promise<{ shas: string[]; nextCommitId: string | null }> {
    const model = this.require();
    // Catch up with git first: commits made outside Sift, files changed since they were approved.
    const outcome = await this.sync(model);
    const ids = commitIds.filter((id) => model.state.commits.some((c) => c.id === id && c.status !== 'committed'));
    if (ids.length === 0) {
      await this.persist();
      throw new Error(outcome.committedOutside.length > 0 ? 'Already committed outside Sift.' : 'There is nothing to commit.');
    }
    const before = new Set<string>();
    for (const id of ids) {
      const unapproved = options.allowUnapproved ? 0 : model.unapprovedCount(id);
      const blocker =
        model.commitBlocker(id, before) ??
        (unapproved > 0 ? `${unapproved} file(s) in "${subjectOf(model.getCommit(id))}" are not approved yet.` : null);
      if (blocker) {
        await this.persist();
        throw new Error(outcome.unapproved.length > 0 ? `${blocker} Some files changed after you approved them.` : blocker);
      }
      before.add(id);
    }

    const current = model.state.session.currentCommitId;
    const shas: string[] = [];
    try {
      for (const id of ids) {
        const commit = model.getCommit(id);
        // Parts of split files are worked out against HEAD as it is now, after the commits before.
        const sha = await commitEntries(this.git, await this.stageEntriesOf(model.filesOf(id)), commit.message);
        await setCommitRef(this.git, model.state.session.id, id, sha);
        model.markCommitted(id, sha);
        shas.push(sha);
      }
    } finally {
      await this.sync(model);
      await this.persist();
    }
    let next: string | null = model.state.session.currentCommitId;
    if (!next && current && ids.includes(current)) {
      next = model.commitsInOrder().find((c) => c.status !== 'committed')?.id ?? null;
      if (next) {
        model.startCommit(next);
        if (!model.latestIteration(next)) {
          await this.snapshot(next, 'initial', true);
        }
      }
    }
    await this.persist();
    return { shas, nextCommitId: next };
  }

  /** Commits the commit in review, which must be approved. */
  async approveCurrent(): Promise<{ sha: string; nextCommitId: string | null }> {
    const current = this.require().currentCommit();
    if (!current) {
      await this.sync(this.require());
      throw new Error('No commit is in review.');
    }
    const { shas, nextCommitId } = await this.commitCommits([current.id]);
    return { sha: shas[0], nextCommitId };
  }

  /** The git commits that undoing this planned commit would undo too (made on top of it), newest first. */
  async commitsUndoneWith(commitId: string): Promise<Array<{ sha: string; subject: string }>> {
    const commit = this.require().getCommit(commitId);
    return commit.sha ? commitsAfter(this.git, commit.sha) : [];
  }

  /**
   * Undoes a commit that was not pushed: it, and every commit made after it, go back to the plan
   * as uncommitted changes, keeping their approvals.
   */
  async undoCommit(commitId: string): Promise<void> {
    const model = this.require();
    const commit = model.getCommit(commitId);
    if (commit.status !== 'committed' || !commit.sha) {
      throw new Error(`"${subjectOf(commit)}" is not committed.`);
    }
    const operation = await operationInProgress(this.git);
    if (operation) {
      throw new Error(`Finish ${operation} first.`);
    }
    if (!(await inHeadHistory(this.git, commit.sha))) {
      throw new Error(`"${subjectOf(commit)}" is not in the current branch's history.`);
    }
    if (await this.isPushed(commit.sha)) {
      throw new Error(`"${subjectOf(commit)}" was pushed. Revert it instead.`);
    }
    await undoCommits(this.git, commit.sha);
    await this.sync(model);
    await this.persist();
  }

  /** Makes a new commit that undoes a committed one (the way to take back a pushed commit). */
  async revertCommit(commitId: string): Promise<string> {
    const model = this.require();
    const commit = model.getCommit(commitId);
    if (commit.status !== 'committed' || !commit.sha) {
      throw new Error(`"${subjectOf(commit)}" is not committed.`);
    }
    if (commit.revertedBy) {
      throw new Error(`"${subjectOf(commit)}" is already reverted.`);
    }
    const operation = await operationInProgress(this.git);
    if (operation) {
      throw new Error(`Finish ${operation} first.`);
    }
    const kept = model.dependentsOf(commitId).filter((c) => c.status === 'committed' && !c.revertedBy);
    if (kept.length > 0) {
      throw new Error(`"${subjectOf(kept[0])}" builds on "${subjectOf(commit)}". Revert it first.`);
    }
    const sha = await revertCommit(this.git, commit.sha);
    await setCommitRef(this.git, model.state.session.id, commitId, sha, 'revert');
    await this.sync(model);
    await this.persist();
    return sha;
  }

  /**
   * Throws away the uncommitted changes of these files: back to HEAD, new files deleted. For a part
   * of a split file, only the part's own changes go.
   */
  async discard(refs: Array<string | FileRef>): Promise<void> {
    const model = this.require();
    const files = this.pendingFiles(refs);
    if (files.length === 0) {
      throw new Error('Nothing to discard: these files have no uncommitted changes.');
    }
    const entries: Array<{ path: string; changeType: ReviewFile['changeType']; content?: string }> = [];
    for (const file of files) {
      entries.push(
        model.isSplit(file.path)
          ? { path: file.path, changeType: file.changeType, content: await this.partText(file.path, file.commitId, false) }
          : { path: file.path, changeType: file.changeType },
      );
    }
    await discardEntries(this.git, entries);
    await this.refresh();
  }

  /** Committed commits of this review that changes can still be amended into: made here, not pushed or reverted. */
  amendTargets(): PlanCommit[] {
    return this.require()
      .commitsInOrder()
      .filter((c) => c.status === 'committed' && c.sha && !c.pushed && !c.revertedBy);
  }

  /**
   * Folds files (or parts of split files) into a commit already made and not pushed, rewriting it
   * and the commits after it. Sift's records of those commits follow the rewrite.
   */
  async amend(refs: Array<string | FileRef>, targetId: string): Promise<string> {
    const model = this.require();
    const target = model.getCommit(targetId);
    if (target.status !== 'committed' || !target.sha) {
      throw new Error(`"${subjectOf(target)}" is not committed yet: move the files to it instead.`);
    }
    const operation = await operationInProgress(this.git);
    if (operation) {
      throw new Error(`Finish ${operation} first.`);
    }
    if (!(await inHeadHistory(this.git, target.sha))) {
      throw new Error(`"${subjectOf(target)}" is not in the current branch's history.`);
    }
    if (await this.isPushed(target.sha)) {
      throw new Error(`"${subjectOf(target)}" was pushed, so amending it would rewrite shared history. Commit the change on its own instead.`);
    }
    await this.sync(model);
    const files = this.pendingFiles(refs);
    if (files.length === 0) {
      throw new Error('Nothing to amend: these files have no uncommitted changes.');
    }
    const rewritten = await amendInto(this.git, target.sha, await this.stageEntriesOf(files));
    const sessionId = model.state.session.id;
    for (const kind of ['commit', 'revert'] as const) {
      for (const [commitId, sha] of await readCommitRefs(this.git, sessionId, kind)) {
        const moved = rewritten.get(sha);
        if (moved) {
          await setCommitRef(this.git, sessionId, commitId, moved, kind);
        }
      }
    }
    model.absorb(files, targetId);
    await this.sync(model);
    await this.persist();
    return model.getCommit(targetId).sha ?? '';
  }

  /** The branch, its upstream and how far apart they are. */
  async branch(): Promise<BranchStatus> {
    return branchStatus(this.git);
  }

  /** The pending entries the references stand for (whole files, or parts of split files). */
  private pendingFiles(refs: Array<string | FileRef>): ReviewFile[] {
    const model = this.require();
    const files = new Set<ReviewFile>();
    for (const ref of refs) {
      const entries =
        typeof ref === 'string' || ref.commitId === undefined
          ? model.pendingEntries(typeof ref === 'string' ? ref : ref.path)
          : [model.findFile(ref.path, ref.commitId)].filter((f): f is ReviewFile => f !== undefined && model.pendingEntries(f.path).includes(f));
      entries.forEach((f) => files.add(f));
    }
    return [...files];
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
    const hunks = new Map<string, Hunk[]>();
    for (const filePath of planSplitPaths(plan)) {
      if (review.findFile(filePath)) {
        hunks.set(filePath, await this.hunksOf(filePath));
      }
    }
    const { unassigned } = review.applyPlan(plan, requireAll, hunks);
    if (hunks.size > 0) {
      await this.sync(review); // works out the parts of the files the plan split
    }
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
  async openDiff(filePath: string, compare?: { from: number | 'HEAD'; to?: number }, commitId?: string | null): Promise<void> {
    const model = this.require();
    const file = model.findFile(filePath, commitId);
    if (!file) {
      throw new Error(`${filePath} is not part of this review.`);
    }
    if (!compare && model.isSplit(filePath) && model.pendingEntries(filePath).includes(file)) {
      // A part of a split file: only its own changes, on the file as it is.
      const all = await fileHunks(this.git, filePath);
      const where = file.commitId ? `commit ${model.getCommit(file.commitId).order}` : 'unassigned';
      const own = model.ownKeys(file, all.map((h) => h.key)).length;
      await vscode.commands.executeCommand(
        'vscode.diff',
        snapshotUri(partQuery(file.commitId, hunkSignature(all.map((h) => h.key))), filePath),
        this.fileUri(filePath),
        `${path.basename(filePath)} (${own} of ${all.length} changes · ${where})`,
        { preview: true },
      );
      if (model.markOpened(filePath, file.commitId)) {
        await this.persist();
      }
      return;
    }

    const name = path.basename(filePath);
    const workingTree = file.changeType === 'deleted' ? snapshotUri('empty', filePath) : this.fileUri(filePath);
    const iterations = file.commitId ? model.iterationsOf(file.commitId) : [];
    // Version numbers in titles are the file's own: they only go up when the file changed.
    const version = (n: number) => `v${model.fileVersionAt(file.commitId, filePath, n)}`;
    const versions = model.fileVersions(file.commitId, filePath);
    const latest = versions.at(-1);
    const previous = versions.at(-2);

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
      title = `${name} (${from ? version(from.n) : 'HEAD'} ↔ ${to ? version(to.n) : 'now'})`;
    } else if (this.diffMode === 'round' && file.changedSinceApproval && file.approvedBefore && (await this.hasApproved(file.approvedBefore))) {
      // Edited after approval: only what changed since then.
      left = file.approvedBefore === DELETED_BLOB ? snapshotUri('empty', filePath) : snapshotUri(`blob:${file.approvedBefore}`, filePath);
      title = `${name} (approved ↔ now · changed since approval)`;
    } else if (this.diffMode === 'round' && latest && previous && file.changedInIteration !== undefined) {
      // The file's last change, while it is unseen; once approved, the whole change again.
      left = snapshotUri(previous.treeSha, filePath);
      title = `${name} (${version(previous.n)} ↔ ${version(latest.n)} · latest changes)`;
    } else if (latest) {
      title = `${name} (HEAD ↔ ${version(latest.n)} · all changes)`;
    }

    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    if (model.markOpened(filePath, file.commitId)) {
      await this.persist();
    }
  }

  private async hasApproved(blob: string): Promise<boolean> {
    return blob === DELETED_BLOB || hasBlob(this.git, blob);
  }

  /** Path of the file shown in the active editor, when it belongs to the review. */
  activeFilePath(): string | null {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? this.reviewPath(uri) : null;
  }

  /**
   * The file in the active editor, with the commit of the part shown when it is a diff of a part of
   * a split file.
   */
  activeFileRef(): FileRef | null {
    const filePath = this.activeFilePath();
    if (!filePath) {
      return null;
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff && input.original.scheme === SCHEME) {
      const part = parsePartQuery(input.original.query);
      if (part && input.original.path.replace(/^\//, '') === filePath) {
        return { path: filePath, commitId: part.commitId };
      }
    }
    return { path: filePath };
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

    const changed = previous ? await this.snapshots.changedPaths(previous.treeSha, tree) : undefined;
    if (changed && !force && !model.filesOf(commitId).some((f) => changed.includes(f.path))) {
      return null; // only files of other commits changed: no new version of any file here
    }
    const n = model.nextIterationNumber(commitId);
    const sessionId = model.state.session.id;
    const snapshot = await this.snapshots.store(tree, snapshotRef(sessionId, commitId, n), `sift ${commitId} v${n}`);
    model.addIteration({
      n,
      changed,
      commitId,
      treeSha: snapshot.treeSha,
      commitSha: snapshot.commitSha,
      ref: snapshot.ref,
      author,
      createdAt: new Date().toISOString(),
    });

    if (changed) {
      model.applyRoundChanges(changed, n);
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
      throw new Error('No review session. Click "Plan commits with AI" or "Plan commits manually" first.');
    }
    return this.model;
  }

  private async persist(): Promise<void> {
    if (this.model) {
      try {
        await this.store.save(this.model.state);
      } catch (error) {
        if (!(error instanceof StaleStateError)) {
          throw error;
        }
        // Something else (an agent, a hand edit, another window) saved the plan meanwhile: theirs wins.
        await this.reloadState();
        throw new Error('The plan was changed outside this window, so Sift loaded that version. Try again.');
      }
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
