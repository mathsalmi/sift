import type { FileChange } from '../git/changes';
import { hunkSignature, type Hunk } from '../git/hunks';
import type {
  CommitReviewStatus,
  FileRef,
  FileStatus,
  HunkRef,
  Iteration,
  MessageAuthor,
  PlanCommit,
  PlanInput,
  ReviewFile,
  ReviewState,
  ReviewThread,
  ThreadKind,
} from './types';

/** What git says right now, gathered by the controller for `sync`. */
export interface GitFacts {
  /** Files that differ between HEAD and the working tree. */
  changes: FileChange[];
  /** Planned commits whose recorded git commit is in HEAD's history: plan commit id → sha. */
  inHistory: Map<string, string>;
  /** For files no longer changed: the newest commit since the session's base that touched them (age 0 = newest). */
  lastTouch: Map<string, { sha: string; age: number }>;
  /** Current content id of changed files that are approved. */
  blobs: Map<string, string>;
  /** The blocks of changes of files split across commits (see splitPaths), by path. */
  hunks?: Map<string, Hunk[]>;
}

/** What `sync` concluded, by commit subject, plus the commit refs the controller must write. */
export interface SyncOutcome {
  /** Planned commits found committed outside Sift. */
  committedOutside: string[];
  /** Planned commits whose files were reverted: removed from the plan. */
  removed: string[];
  /** Commits that left HEAD's history (reset, dropped in a rebase) and are back in the plan. */
  reopened: string[];
  /** Approved files whose content changed since: back to In progress. */
  unapproved: string[];
  /** Plan commit id → git commit to record, or null to forget it. */
  refs: Map<string, string | null>;
}

export function emptyOutcome(): SyncOutcome {
  return { committedOutside: [], removed: [], reopened: [], unapproved: [], refs: new Map() };
}

export interface NewThread {
  kind: ThreadKind;
  path: string;
  line: number;
  lineText: string;
  body: string;
  author: MessageAuthor;
  model?: string;
}

export interface Progress {
  doneFiles: number;
  totalFiles: number;
  committedCommits: number;
  commitCount: number;
  currentIndex: number | null;
  currentIteration: number | null;
}

/**
 * All review rules, with no VS Code or git dependency.
 * Mutates the wrapped state in place; the caller persists it.
 */
export class ReviewModel {
  /** Bumped on every change that affects comment threads; the UI re-renders threads only when it moves. */
  threadsRevision = 0;

  constructor(readonly state: ReviewState) {}

  static create(sessionId: string, head: string, changes: FileChange[], now: string): ReviewModel {
    return new ReviewModel({
      version: 2,
      session: {
        id: sessionId,
        baseCommit: head,
        currentCommitId: null,
        status: 'active',
        createdAt: now,
        showExplanations: true,
      },
      commits: [],
      files: changes.map((change) => newFile(change)),
      iterations: [],
      threads: [],
    });
  }

  // ---- queries ----

  commitsInOrder(): PlanCommit[] {
    return [...this.state.commits].sort((a, b) => a.order - b.order);
  }

  getCommit(commitId: string): PlanCommit {
    const commit = this.state.commits.find((c) => c.id === commitId);
    if (!commit) {
      throw new Error(`Unknown commit ${commitId}.`);
    }
    return commit;
  }

  /**
   * The entry for a path in a commit (with `commitId`), else its pending entry: for a file split
   * across commits, its part in the commit in review, else the main part. Falls back to its
   * committed history entry.
   */
  findFile(filePath: string, commitId?: string | null): ReviewFile | undefined {
    const matches = this.state.files.filter((f) => f.path === filePath);
    if (commitId !== undefined) {
      return matches.find((f) => f.commitId === commitId && !this.isCommittedFile(f)) ?? matches.find((f) => f.commitId === commitId);
    }
    const pending = matches.filter((f) => !this.isCommittedFile(f));
    const current = this.state.session.currentCommitId;
    return (
      pending.find((f) => current !== null && f.commitId === current) ??
      pending.find((f) => !f.hunks) ??
      pending[0] ??
      matches[0]
    );
  }

  resolve(ref: string | FileRef): ReviewFile | undefined {
    return typeof ref === 'string' ? this.findFile(ref) : this.findFile(ref.path, ref.commitId);
  }

  /** The entries of a path not committed yet: one per commit a split file is split across. */
  pendingEntries(filePath: string): ReviewFile[] {
    return this.state.files.filter((f) => f.path === filePath && !this.isCommittedFile(f));
  }

  /** Whether the file's changes are split across commits. */
  isSplit(filePath: string): boolean {
    const entries = this.pendingEntries(filePath);
    return entries.length > 1 || entries.some((f) => f.hunks);
  }

  /** Paths of files split across commits. */
  splitPaths(): string[] {
    return [...new Set(this.state.files.filter((f) => !this.isCommittedFile(f)).map((f) => f.path))].filter((p) => this.isSplit(p));
  }

  /**
   * Paths whose blocks of changes sync needs: split files, and files approved as a part that may
   * have just become whole (their approval is checked against those blocks).
   */
  hunkPaths(): string[] {
    const approvedParts = this.state.files
      .filter((f) => !this.isCommittedFile(f) && f.approvedBlob?.startsWith('hunks:'))
      .map((f) => f.path);
    return [...new Set([...this.splitPaths(), ...approvedParts])];
  }

  /** The keys of the blocks of changes an entry holds, out of all of the file's (`all`). */
  ownKeys(file: ReviewFile, all: string[]): string[] {
    if (file.hunks) {
      const own = new Set(file.hunks.map((h) => h.key));
      return all.filter((k) => own.has(k));
    }
    const claimed = new Set(
      this.pendingEntries(file.path)
        .filter((f) => f !== file && f.hunks)
        .flatMap((f) => f.hunks!.map((h) => h.key)),
    );
    return all.filter((k) => !claimed.has(k));
  }

  filesOf(commitId: string | null): ReviewFile[] {
    return this.state.files
      .filter((f) => f.commitId === commitId)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  currentCommit(): PlanCommit | null {
    const id = this.state.session.currentCommitId;
    if (!id) {
      return null;
    }
    return this.getCommit(id);
  }

  iterationsOf(commitId: string): Iteration[] {
    return this.state.iterations.filter((i) => i.commitId === commitId).sort((a, b) => a.n - b.n);
  }

  /**
   * The snapshots that hold a new version of the file: the first one, then each one that changed it.
   * Index k is the file's version k, so a file nobody touched stays at v0 while others move on.
   */
  fileVersions(commitId: string | null, filePath: string): Iteration[] {
    if (!commitId) {
      return [];
    }
    return this.iterationsOf(commitId).filter((i, index) => index === 0 || (i.changed ?? []).includes(filePath));
  }

  /** The file's version in snapshot `n` of its commit (0 when it never changed). */
  fileVersionAt(commitId: string | null, filePath: string, n: number): number {
    const versions = this.fileVersions(commitId, filePath).filter((i) => i.n <= n);
    return Math.max(versions.length - 1, 0);
  }

  /** The file's latest version number, or null before its commit has a snapshot. */
  fileVersion(file: ReviewFile): number | null {
    const versions = this.fileVersions(file.commitId, file.path);
    return versions.length > 0 ? versions.length - 1 : null;
  }

  latestIteration(commitId: string): Iteration | null {
    const iterations = this.iterationsOf(commitId);
    return iterations.at(-1) ?? null;
  }

  /** First file still to do in the commit, after `afterPath` when given (wrapping around). */
  nextTodo(commitId: string, afterPath?: string): ReviewFile | null {
    const files = this.filesOf(commitId).filter((f) => f.status !== 'done');
    if (files.length === 0) {
      return null;
    }
    if (!afterPath) {
      return files.find((f) => f.status === 'todo') ?? files[0];
    }
    const later = files.find((f) => f.path.localeCompare(afterPath) > 0);
    return later ?? files[0];
  }

  /**
   * The next file to review after this commit is done: the first one left in the commits that come
   * after it (wrapping around), skipping committed ones. Null when every planned file is approved.
   */
  nextTodoInOtherCommit(commitId: string | null): ReviewFile | null {
    const commits = this.commitsInOrder().filter((c) => c.status !== 'committed');
    const at = commits.findIndex((c) => c.id === commitId);
    const ordered = [...commits.slice(at + 1), ...commits.slice(0, Math.max(at, 0))];
    for (const commit of ordered) {
      const next = this.nextTodo(commit.id);
      if (next) {
        return next;
      }
    }
    return null;
  }

  /** All files approved → approved; some → in progress; none → to do. */
  commitReviewStatus(commitId: string): CommitReviewStatus {
    if (this.getCommit(commitId).status === 'committed') {
      return 'committed';
    }
    const files = this.filesOf(commitId);
    const approved = files.filter((f) => f.status === 'done').length;
    if (files.length > 0 && approved === files.length) {
      return 'approved';
    }
    return approved > 0 ? 'in-progress' : 'todo';
  }

  /** The file before/after `filePath` in its commit (or in Unassigned), without wrapping. */
  adjacentFile(filePath: string, delta: -1 | 1, commitId?: string | null): ReviewFile | null {
    const file = this.findFile(filePath, commitId);
    if (!file) {
      return null;
    }
    const files = this.filesOf(file.commitId);
    const index = files.indexOf(file);
    return files[index + delta] ?? null;
  }

  progress(): Progress {
    const commits = this.commitsInOrder();
    const current = this.state.session.currentCommitId;
    const currentIndex = current ? commits.findIndex((c) => c.id === current) : -1;
    return {
      doneFiles: this.state.files.filter((f) => f.status === 'done').length,
      totalFiles: this.state.files.length,
      committedCommits: commits.filter((c) => c.status === 'committed').length,
      commitCount: commits.length,
      currentIndex: currentIndex >= 0 ? currentIndex : null,
      currentIteration: current ? (this.latestIteration(current)?.n ?? null) : null,
    };
  }

  /** Why the commit can't be approved yet, or null when it can. */
  approvalBlocker(commitId: string): string | null {
    const blocker = this.commitBlocker(commitId);
    if (blocker) {
      return blocker;
    }
    const pending = this.unapprovedCount(commitId);
    if (pending > 0) {
      return `${pending} file(s) in this commit are not approved yet.`;
    }
    return null;
  }

  /**
   * Why the commit can't be committed at all, approved or not, or null when it can. `before`: commits
   * that will be committed ahead of it, which count as committed dependencies.
   */
  commitBlocker(commitId: string, before: ReadonlySet<string> = new Set()): string | null {
    const commit = this.getCommit(commitId);
    if (commit.status === 'committed') {
      return `"${subjectOf(commit)}" is already committed.`;
    }
    if (!commit.message.trim()) {
      return 'The commit has no message.';
    }
    if (this.filesOf(commitId).length === 0) {
      return `"${subjectOf(commit)}" has no files.`;
    }
    for (const dependency of this.dependenciesOf(commitId)) {
      if (dependency.revertedBy) {
        return `"${subjectOf(commit)}" builds on "${subjectOf(dependency)}", which was reverted.`;
      }
      if (dependency.status !== 'committed' && !before.has(dependency.id)) {
        return `"${subjectOf(commit)}" builds on "${subjectOf(dependency)}", which is not committed yet.`;
      }
    }
    return null;
  }

  /** Files of the commit that are not approved yet. */
  unapprovedCount(commitId: string): number {
    return this.filesOf(commitId).filter((f) => f.status !== 'done').length;
  }

  /**
   * The commits to make, in order. With a target: its uncommitted dependencies (and theirs), then the
   * target. Without one: every approved commit whose dependencies are committed or come with it.
   */
  commitBatch(target?: string): PlanCommit[] {
    if (target) {
      const wanted = new Set<string>();
      const add = (id: string) => {
        const commit = this.getCommit(id);
        if (commit.status === 'committed' || wanted.has(id)) {
          return;
        }
        wanted.add(id);
        for (const dependency of this.dependenciesOf(id)) {
          add(dependency.id);
        }
      };
      add(target);
      return this.commitsInOrder().filter((c) => wanted.has(c.id));
    }
    const batch: PlanCommit[] = [];
    const ids = new Set<string>();
    for (const commit of this.commitsInOrder()) {
      if (commit.status === 'committed' || this.commitReviewStatus(commit.id) !== 'approved') {
        continue;
      }
      if (this.commitBlocker(commit.id, ids) === null) {
        batch.push(commit);
        ids.add(commit.id);
      }
    }
    return batch;
  }

  /** The commits this one builds on, in plan order. */
  dependenciesOf(commitId: string): PlanCommit[] {
    const ids = new Set(this.getCommit(commitId).dependsOn ?? []);
    return this.commitsInOrder().filter((c) => ids.has(c.id));
  }

  /** The commits that build on this one, in plan order. */
  dependentsOf(commitId: string): PlanCommit[] {
    return this.commitsInOrder().filter((c) => c.dependsOn?.includes(commitId));
  }

  // ---- git ----

  /**
   * Brings the review in line with git. Everything git knows is taken from `facts`, never from
   * what was saved, so the review can't drift from the repository:
   *
   * - A planned commit is committed when its recorded git commit is in HEAD's history, or when
   *   none of its files differ from HEAD anymore and a commit since the session started touched
   *   them (committed in a terminal, squashed, rebased). If nothing touched them, they were
   *   reverted and the commit leaves the plan. A commit that left HEAD's history is planned again.
   * - Changed files come from `facts.changes`; files of committed commits stay as history.
   * - An approval holds only while the file's content is the one that was approved.
   *
   * Commits created empty by hand are left alone.
   */
  sync(facts: GitFacts): SyncOutcome {
    const outcome = emptyOutcome();
    const changed = new Map(facts.changes.map((c) => [c.path, c]));

    for (const commit of this.commitsInOrder()) {
      const subject = commit.message.split('\n')[0].trim();
      const wasCommitted = commit.status === 'committed';
      const recorded = facts.inHistory.get(commit.id);
      if (recorded) {
        commit.status = 'committed';
        commit.sha = recorded;
        continue;
      }
      const files = this.filesOf(commit.id);
      if (files.length > 0 && files.every((f) => !changed.has(f.path))) {
        const touch = files
          .map((f) => facts.lastTouch.get(f.path))
          .filter((t) => t !== undefined)
          .sort((x, y) => x.age - y.age)[0];
        if (touch) {
          commit.status = 'committed';
          commit.sha = touch.sha;
          outcome.refs.set(commit.id, touch.sha);
          if (!wasCommitted) {
            outcome.committedOutside.push(subject);
          }
        } else {
          this.forgetCommit(commit.id);
          this.state.threads = this.state.threads.filter((t) => t.commitId !== commit.id);
          this.state.files = this.state.files.filter((f) => f.commitId !== commit.id);
          outcome.refs.set(commit.id, null);
          outcome.removed.push(subject);
        }
        continue;
      }
      if (wasCommitted) {
        outcome.refs.set(commit.id, null);
        outcome.reopened.push(subject);
      }
      commit.sha = undefined;
      commit.status = this.state.session.currentCommitId === commit.id ? 'in-review' : 'planned';
    }

    // Files: history of committed commits, then the pending entries of each changed path (one, or
    // one per commit a split file is split across).
    const pending = new Map<string, ReviewFile[]>();
    const kept: ReviewFile[] = [];
    for (const file of this.state.files) {
      if (this.isCommittedFile(file)) {
        file.status = 'done';
        kept.push(file);
      } else if (changed.has(file.path)) {
        pending.set(file.path, [...(pending.get(file.path) ?? []), file]);
      }
    }
    for (const [filePath, entries] of pending) {
      const change = changed.get(filePath)!;
      const merged = mergeDuplicates(entries);
      const split = merged.length > 1 || merged.some((f) => f.hunks);
      const hunks = facts.hunks?.get(filePath);
      const parts = split && hunks && hunks.length > 0 ? this.settleParts(merged, hunks, outcome) : collapse(merged);
      for (const file of parts) {
        file.changeType = change.changeType;
        file.binary = change.binary;
        if (!file.part) {
          file.adds = change.adds;
          file.dels = change.dels;
        }
        kept.push(file);
      }
    }
    for (const change of facts.changes) {
      if (!pending.has(change.path)) {
        kept.push(newFile(change));
      }
    }
    this.state.files = kept;

    // Reviews from before unassigned files had no status.
    for (const file of kept) {
      if (!file.commitId && file.status !== 'todo') {
        this.clearReview(file);
      }
    }

    // Approvals hold only for the content that was approved (parts of split files: for their changes).
    for (const file of kept) {
      if (file.status !== 'done' || this.isCommittedFile(file) || file.part) {
        continue;
      }
      const blob = facts.blobs.get(file.path);
      if (blob === undefined) {
        continue;
      }
      if (file.approvedBlob?.startsWith('hunks:')) {
        // A part that now holds all of the file's changes: still approved if they are the ones approved.
        const all = facts.hunks?.get(file.path);
        if (all && hunkSignature(all.map((h) => h.key)) === file.approvedBlob) {
          file.approvedBlob = blob;
          continue;
        }
      }
      if (file.approvedBlob === undefined) {
        file.approvedBlob = blob; // approved before approvals were tied to content
      } else if (file.approvedBlob !== blob) {
        file.status = 'in-progress';
        file.approvedBefore = file.approvedBlob.startsWith('hunks:') ? undefined : file.approvedBlob;
        file.approvedBlob = undefined;
        file.changedSinceApproval = true;
        outcome.unapproved.push(file.path);
      }
    }

    const current = this.state.session.currentCommitId;
    if (current && !this.state.commits.some((c) => c.id === current && c.status !== 'committed')) {
      this.state.session.currentCommitId = null;
    }
    if (outcome.refs.size > 0) {
      this.threadsRevision++;
    }
    this.finishIfDone();
    return outcome;
  }

  /**
   * Splits a file's current blocks of changes among its parts: each part keeps the ones it holds; a
   * block that changed goes to the part that held the block it replaced (where it was), and the rest
   * to the main part (Unassigned when there is none). Parts left with nothing go away; a lone part is
   * the whole file again. A part's approval holds while its blocks stay the same.
   */
  private settleParts(entries: ReviewFile[], hunks: Hunk[], outcome: SyncOutcome): ReviewFile[] {
    const keys = new Set(hunks.map((h) => h.key));
    const owner = new Map<string, ReviewFile>();
    const vanished: Array<{ file: ReviewFile; ref: HunkRef }> = [];
    for (const file of entries) {
      for (const ref of file.hunks ?? []) {
        if (keys.has(ref.key) && !owner.has(ref.key)) {
          owner.set(ref.key, file);
        } else {
          vanished.push({ file, ref });
        }
      }
    }
    for (const hunk of hunks) {
      if (owner.has(hunk.key)) {
        continue;
      }
      const end = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
      const near = vanished.find(({ ref }) => ref.start <= end + 1 && hunk.newStart <= ref.start + Math.max(ref.lines, 1));
      if (near) {
        owner.set(hunk.key, near.file);
      }
    }
    let main = entries.find((f) => !f.hunks);
    const unowned = hunks.filter((h) => !owner.has(h.key));
    if (unowned.length > 0 && !main) {
      main = { ...entries[0], commitId: null, status: 'todo', hunks: undefined, part: undefined, approvedBlob: undefined };
      delete main.changedSinceApproval;
      delete main.approvedBefore;
      delete main.changedInIteration;
      entries = [...entries, main];
    }
    const own = (file: ReviewFile) => hunks.filter((h) => (owner.get(h.key) ?? main) === file);
    const parts = entries.filter((f) => own(f).length > 0);
    if (parts.length === 1) {
      const [whole] = parts;
      whole.hunks = undefined;
      whole.part = undefined;
      return parts;
    }
    for (const file of parts) {
      const mine = own(file);
      if (file.hunks) {
        file.hunks = mine.map((h) => ({ key: h.key, start: h.newStart, lines: h.newLines }));
      }
      file.part = { own: mine.length, total: hunks.length };
      file.adds = mine.reduce((sum, h) => sum + h.added.length, 0);
      file.dels = mine.reduce((sum, h) => sum + h.removed.length, 0);
      if (file.status !== 'done' || !file.commitId) {
        continue;
      }
      const signature = hunkSignature(mine.map((h) => h.key));
      if (file.approvedBlob === undefined || !file.approvedBlob.startsWith('hunks:')) {
        file.approvedBlob = signature;
      } else if (file.approvedBlob !== signature) {
        file.status = 'in-progress';
        file.approvedBlob = undefined;
        file.changedSinceApproval = true;
        outcome.unapproved.push(file.path);
      }
    }
    return parts;
  }

  /** Paths of files that left the working tree's changes while their commit isn't known as committed. */
  pathsToTrace(changedPaths: Set<string>, inHistory: Map<string, string>): string[] {
    const paths = this.state.files
      .filter((f) => f.commitId !== null && !inHistory.has(f.commitId) && !changedPaths.has(f.path))
      .map((f) => f.path);
    return [...new Set(paths)];
  }

  /** Paths of approved pending files, whose content must be checked. */
  approvedPaths(): string[] {
    return this.state.files.filter((f) => f.status === 'done' && !this.isCommittedFile(f)).map((f) => f.path);
  }

  /** Fills the change type and line counts of a committed commit's files from what its git commit changed. */
  fillCommitted(commitId: string, changes: FileChange[]): void {
    const byPath = new Map(changes.map((c) => [c.path, c]));
    for (const file of this.filesOf(commitId)) {
      const change = byPath.get(file.path);
      if (change) {
        file.changeType = change.changeType;
        file.adds = change.adds;
        file.dels = change.dels;
        file.binary = change.binary;
      }
    }
  }

  /** The session is done once every commit is committed and no file is left unassigned; active otherwise. */
  private finishIfDone(): void {
    const pending = this.state.commits.some((c) => c.status !== 'committed');
    this.state.session.status = !pending && this.filesOf(null).length === 0 ? 'done' : 'active';
  }

  // ---- plan ----

  /** With `requireAll`, every pending file must be in the plan (used for plans coming from the AI). */
  applyPlan(plan: PlanInput, requireAll = false): { unassigned: number } {
    if (!plan || !Array.isArray(plan.commits)) {
      throw new Error('Plan must have a "commits" array.');
    }

    const seen = new Set<string>();
    plan.commits.forEach((commit, index) => {
      if (!commit.message || !commit.message.trim()) {
        throw new Error(`Plan commit #${index + 1} has no message.`);
      }
      if (!Array.isArray(commit.files)) {
        throw new Error(`Plan commit #${index + 1} has no "files" array.`);
      }
      for (const filePath of commit.files) {
        const file = this.findFile(filePath);
        if (!file) {
          throw new Error(`Plan lists "${filePath}", which is not a changed file.`);
        }
        if (this.isCommittedFile(file)) {
          throw new Error(`Plan lists "${filePath}", which is already committed.`);
        }
        if (seen.has(filePath)) {
          throw new Error(`Plan lists "${filePath}" more than once.`);
        }
        seen.add(filePath);
      }
      if (commit.dependsOn !== undefined && !Array.isArray(commit.dependsOn)) {
        throw new Error(`Plan commit #${index + 1}: "dependsOn" must be an array of commit numbers.`);
      }
      for (const dependency of commit.dependsOn ?? []) {
        if (!Number.isInteger(dependency) || dependency < 1 || dependency > index) {
          throw new Error(`Plan commit #${index + 1} depends on #${String(dependency)}; it can only depend on commits before it.`);
        }
      }
      for (const note of commit.explanations ?? []) {
        if (!commit.files.includes(note?.path)) {
          throw new Error(`Plan commit #${index + 1} explains "${note?.path}", which is not one of its files.`);
        }
        if (!Number.isInteger(note.line) || note.line < 1) {
          throw new Error(`Explanation on "${note.path}" needs a 1-based "line".`);
        }
        if (typeof note.body !== 'string' || !note.body.trim()) {
          throw new Error(`Explanation on "${note.path}" line ${note.line} has no "body".`);
        }
      }
    });

    if (requireAll) {
      const missing = this.state.files.filter((f) => !this.isCommittedFile(f) && !seen.has(f.path)).map((f) => f.path);
      if (missing.length > 0) {
        throw new Error(`Plan leaves out ${missing.length} changed file(s): ${missing.slice(0, 10).join(', ')}`);
      }
    }

    const committed = this.state.commits.filter((c) => c.status === 'committed');
    const committedIds = new Set(committed.map((c) => c.id));
    // A planned commit with the same message as one in the plan stays that commit: it keeps its id,
    // versions, comments and file reviews, so a plan can be updated without starting the review over.
    const reusable = this.reusableCommits(plan);
    const kept = new Set([...reusable.values()].map((c) => c.id));
    this.state.commits = [...committed, ...reusable.values()];
    for (const file of this.state.files) {
      if (!this.isCommittedFile(file)) {
        file.commitId = file.commitId && kept.has(file.commitId) ? file.commitId : null;
      }
    }
    const current = this.state.session.currentCommitId;
    if (current && !committedIds.has(current) && !kept.has(current)) {
      this.state.session.currentCommitId = null;
    }

    let order = committed.reduce((max, c) => Math.max(max, c.order), 0);
    const placed: PlanCommit[] = [];
    plan.commits.forEach((input, index) => {
      const reused = reusable.get(index);
      const commit = reused ?? this.addCommit(input.message, input.intent ?? '', input.riskNotes ?? []);
      if (reused) {
        reused.message = input.message.trim();
        reused.intent = input.intent ?? reused.intent;
        reused.riskNotes = input.riskNotes ?? reused.riskNotes;
      }
      commit.order = ++order;
      const before = new Set(placed.map((c) => c.id));
      const dependsOn =
        input.dependsOn !== undefined
          ? [...new Set(input.dependsOn)].map((n) => placed[n - 1].id)
          : (reused?.dependsOn ?? []).filter((id) => before.has(id) || committedIds.has(id));
      commit.dependsOn = dependsOn.length > 0 ? dependsOn : undefined;
      placed.push(commit);
      for (const filePath of input.files) {
        const entries = this.pendingEntries(filePath);
        const file = entries.find((f) => f.commitId === commit.id) ?? entries[0];
        if (!file) {
          continue;
        }
        // A plan places whole files: a split file is one again.
        for (const other of entries.filter((f) => f !== file)) {
          this.state.files.splice(this.state.files.indexOf(other), 1);
        }
        file.hunks = undefined;
        file.part = undefined;
        if (file.commitId !== commit.id || entries.length > 1) {
          file.commitId = commit.id;
          // A file that changes commit is reviewed again in its new one.
          this.clearReview(file);
        }
      }
    });
    // Parts of split files left out of the plan that ended up together (both Unassigned) join.
    for (const filePath of this.splitPaths()) {
      const entries = this.pendingEntries(filePath);
      for (const file of entries) {
        const twin = entries.find((f) => f !== file && f.commitId === file.commitId && this.state.files.includes(f));
        if (twin && this.state.files.includes(file)) {
          twin.hunks = twin.hunks && file.hunks ? [...twin.hunks, ...file.hunks] : undefined;
          this.state.files.splice(this.state.files.indexOf(file), 1);
        }
      }
      this.settleSplit(filePath);
    }
    for (const file of this.state.files) {
      if (!file.commitId && file.status !== 'todo') {
        this.clearReview(file);
      }
    }

    // Explanations of dropped commits go away (the plan brings its own); the user's comments follow their file.
    this.state.threads = this.state.threads.filter(
      (t) => t.kind === 'comment' || (t.commitId !== null && (committedIds.has(t.commitId) || kept.has(t.commitId))),
    );
    for (const thread of this.state.threads) {
      if (thread.commitId === null || !committedIds.has(thread.commitId)) {
        thread.commitId = this.findFile(thread.path)?.commitId ?? null;
      }
    }
    this.threadsRevision++;

    return { unassigned: this.filesOf(null).length };
  }

  /**
   * Planned commits a plan keeps, by the plan's commit index: matched on the whole message, then on the
   * subject, then on most of their files.
   */
  private reusableCommits(plan: PlanInput): Map<number, PlanCommit> {
    const open = this.state.commits.filter((c) => c.status !== 'committed');
    const result = new Map<number, PlanCommit>();
    const taken = new Set<string>();
    const match = (key: (message: string) => string) => {
      plan.commits.forEach((input, index) => {
        if (result.has(index)) {
          return;
        }
        const found = open.find((c) => !taken.has(c.id) && key(c.message) === key(input.message));
        if (found) {
          result.set(index, found);
          taken.add(found.id);
        }
      });
    };
    match((message) => message.trim());
    match((message) => message.split('\n')[0].trim());
    // A reworded commit is still the same commit when it keeps most of its files.
    plan.commits.forEach((input, index) => {
      if (result.has(index)) {
        return;
      }
      const wanted = new Set(input.files);
      const best = open
        .filter((c) => !taken.has(c.id))
        .map((c) => {
          const files = this.filesOf(c.id).map((f) => f.path);
          return { commit: c, shared: files.filter((f) => wanted.has(f)).length, total: files.length };
        })
        .filter((m) => m.shared * 2 > m.total)
        .sort((x, y) => y.shared - x.shared)[0];
      if (best) {
        result.set(index, best.commit);
        taken.add(best.commit.id);
      }
    });
    return result;
  }

  /**
   * Subjects of the planned commits a plan would drop although review already started on them
   * (the commit under review, or one with reviewed files, versions or comments).
   */
  reviewLostByPlan(plan: PlanInput): string[] {
    const kept = new Set([...this.reusableCommits(plan).values()].map((c) => c.id));
    return this.commitsInOrder()
      .filter((c) => c.status !== 'committed' && !kept.has(c.id))
      .filter(
        (c) =>
          c.status === 'in-review' ||
          this.iterationsOf(c.id).length > 0 ||
          this.filesOf(c.id).some((f) => f.status !== 'todo') ||
          this.state.threads.some((t) => t.commitId === c.id && t.kind === 'comment'),
      )
      .map(subjectOf);
  }

  addCommit(message: string, intent = '', riskNotes: string[] = []): PlanCommit {
    const commit: PlanCommit = {
      id: this.nextCommitId(),
      order: this.state.commits.reduce((max, c) => Math.max(max, c.order), 0) + 1,
      message: message.trim(),
      intent,
      riskNotes,
      status: 'planned',
    };
    this.state.commits.push(commit);
    return commit;
  }

  renameCommit(commitId: string, message: string): void {
    const commit = this.editableCommit(commitId);
    if (!message.trim()) {
      throw new Error('Commit message cannot be empty.');
    }
    commit.message = message.trim();
  }

  deleteCommit(commitId: string): void {
    this.editableCommit(commitId);
    this.moveFiles(
      this.filesOf(commitId).map((f) => ({ path: f.path, commitId })),
      null,
    );
    this.forgetCommit(commitId);
    if (this.state.session.currentCommitId === commitId) {
      this.state.session.currentCommitId = null;
    }
  }

  /**
   * Swaps the commit with its neighbour; committed commits stay where they are, and a commit never
   * moves ahead of one it builds on.
   */
  moveCommit(commitId: string, delta: -1 | 1): void {
    const commit = this.editableCommit(commitId);
    const ordered = this.commitsInOrder();
    const index = ordered.findIndex((c) => c.id === commitId);
    const neighbour = ordered.at(index + delta);
    if (index + delta < 0 || !neighbour || neighbour.status === 'committed') {
      return;
    }
    const [first, second] = delta < 0 ? [neighbour, commit] : [commit, neighbour];
    if (second.dependsOn?.includes(first.id)) {
      throw new Error(`"${subjectOf(second)}" builds on "${subjectOf(first)}", so it can't come before it.`);
    }
    [commit.order, neighbour.order] = [neighbour.order, commit.order];
  }

  /** Sets the commits this one builds on: commits that come before it in the plan. */
  setDependencies(commitId: string, dependencyIds: string[]): void {
    const commit = this.editableCommit(commitId);
    for (const id of dependencyIds) {
      const dependency = this.getCommit(id);
      if (dependency.order >= commit.order) {
        throw new Error(`"${subjectOf(commit)}" can only build on commits before it. Move it below "${subjectOf(dependency)}" first.`);
      }
    }
    const ids = new Set(dependencyIds);
    const dependsOn = this.commitsInOrder()
      .filter((c) => ids.has(c.id))
      .map((c) => c.id);
    commit.dependsOn = dependsOn.length > 0 ? dependsOn : undefined;
  }

  /**
   * Moves files to a commit (or Unassigned). A path moves the whole file, joining the parts of a
   * split file; a reference with a commit moves only the file's part in that commit, which joins the
   * file's part already in the target, if any.
   */
  moveFiles(refs: Array<string | FileRef>, commitId: string | null): void {
    if (commitId) {
      this.editableCommit(commitId);
    }
    for (const ref of refs) {
      const filePath = typeof ref === 'string' ? ref : ref.path;
      const entries = this.pendingEntries(filePath);
      const moving =
        typeof ref === 'string' || ref.commitId === undefined ? entries : entries.filter((f) => f.commitId === ref.commitId);
      if (moving.length === 0 || (moving.length === 1 && moving[0].commitId === commitId)) {
        continue;
      }
      const target = entries.find((f) => f.commitId === commitId);
      if (target) {
        // Joining parts: what the target holds now is new to review.
        for (const file of moving.filter((f) => f !== target)) {
          target.hunks = target.hunks && file.hunks ? [...target.hunks, ...file.hunks] : undefined;
          this.state.files.splice(this.state.files.indexOf(file), 1);
        }
        this.reopen(target);
      } else {
        const [first, ...rest] = moving;
        first.commitId = commitId;
        for (const file of rest) {
          first.hunks = first.hunks && file.hunks ? [...first.hunks, ...file.hunks] : undefined;
          this.state.files.splice(this.state.files.indexOf(file), 1);
        }
        if (!commitId) {
          // Unassigned files aren't reviewed: they start over once they join a commit.
          this.clearReview(first);
        } else if (rest.length > 0) {
          this.reopen(first);
        }
      }
      this.settleSplit(filePath);
    }
  }

  /**
   * Moves some blocks of a file's changes (`keys`, out of the file's current `hunks`) from its part
   * in `from` to its part in `to`, making that part when there is none: the file is then split
   * across both commits. Both parts are reviewed again.
   */
  moveHunks(filePath: string, from: string | null, keys: string[], to: string | null, hunks: Hunk[]): void {
    if (to) {
      this.editableCommit(to);
    }
    const source = this.findFile(filePath, from);
    if (!source || this.isCommittedFile(source)) {
      throw new Error(`${filePath} is not a pending file in this review.`);
    }
    if (source.binary || source.changeType !== 'modified') {
      throw new Error(`Only changes to an existing text file can be split; ${filePath} is ${source.binary ? 'binary' : source.changeType}.`);
    }
    const own = new Set(this.ownKeys(source, hunks.map((h) => h.key)));
    const moving = hunks.filter((h) => own.has(h.key) && keys.includes(h.key));
    if (moving.length === 0 || from === to) {
      return;
    }
    if (moving.length === own.size) {
      this.moveFiles([{ path: filePath, commitId: from }], to);
      return;
    }
    const refs = moving.map((h) => ({ key: h.key, start: h.newStart, lines: h.newLines }));
    const movingKeys = new Set(refs.map((r) => r.key));
    if (source.hunks) {
      source.hunks = source.hunks.filter((h) => !movingKeys.has(h.key));
    }
    let target = this.pendingEntries(filePath).find((f) => f.commitId === to);
    if (target?.hunks) {
      target.hunks.push(...refs);
    } else if (target && !source.hunks) {
      // Both would hold "the rest": the source holds what it keeps by name instead.
      source.hunks = hunks.filter((h) => own.has(h.key) && !movingKeys.has(h.key)).map((h) => ({ key: h.key, start: h.newStart, lines: h.newLines }));
    } else if (!target) {
      target = { ...source, commitId: to, status: 'todo', hunks: refs, part: undefined, approvedBlob: undefined };
      delete target.changedSinceApproval;
      delete target.approvedBefore;
      delete target.changedInIteration;
      this.state.files.push(target);
    }
    this.reopen(source);
    if (target) {
      this.reopen(target);
    }
  }

  /** An entry whose content to review changed: an approval no longer covers it. */
  private reopen(file: ReviewFile): void {
    if (!file.commitId) {
      this.clearReview(file);
    } else if (file.status === 'done') {
      file.status = 'in-progress';
      file.approvedBlob = undefined;
    }
  }

  /** A split file left with one part is whole again. */
  private settleSplit(filePath: string): void {
    const entries = this.pendingEntries(filePath);
    if (entries.length === 1) {
      entries[0].hunks = undefined;
      entries[0].part = undefined;
    }
  }

  private clearReview(file: ReviewFile): void {
    file.status = 'todo';
    file.approvedBlob = undefined;
    file.approvedBefore = undefined;
    file.changedSinceApproval = undefined;
  }

  // ---- review loop ----

  startCommit(commitId: string): void {
    const commit = this.editableCommit(commitId);
    const previous = this.currentCommit();
    if (previous && previous.id !== commitId && previous.status === 'in-review') {
      previous.status = 'planned';
    }
    commit.status = 'in-review';
    this.state.session.currentCommitId = commitId;
    this.threadsRevision++;
  }

  /**
   * `approvals`: what an approval covers now, by path (content id), or by path and commit for
   * parts of split files (see approvalKey), so an approval covers exactly this content.
   */
  setStatus(refs: Array<string | FileRef>, status: FileStatus, approvals?: Map<string, string>): void {
    for (const ref of refs) {
      const file = this.resolve(ref);
      // Files are reviewed as part of a commit; unassigned ones have no status.
      if (!file || !file.commitId || this.isCommittedFile(file)) {
        continue;
      }
      file.status = status;
      file.changedSinceApproval = undefined;
      file.approvedBefore = undefined;
      file.approvedBlob = status === 'done' ? (approvals?.get(approvalKey(file)) ?? approvals?.get(file.path)) : undefined;
      if (status === 'done') {
        file.changedInIteration = undefined;
      }
    }
  }

  /** Opening a file to review moves it from to do to in progress. */
  markOpened(filePath: string, commitId?: string | null): boolean {
    const file = this.findFile(filePath, commitId);
    if (!file || !file.commitId || file.status !== 'todo' || this.isCommittedFile(file)) {
      return false;
    }
    file.status = 'in-progress';
    return true;
  }

  addIteration(iteration: Iteration): void {
    this.state.iterations.push(iteration);
  }

  nextIterationNumber(commitId: string): number {
    const latest = this.latestIteration(commitId);
    return latest ? latest.n + 1 : 0;
  }

  /** Files changed by a new round: Done goes back to In progress so nothing changes unseen. */
  /** Fills `changed` on snapshots saved before it was recorded. */
  missingChanges(): Iteration[] {
    return this.state.iterations.filter((i) => i.n > 0 && i.changed === undefined);
  }

  applyRoundChanges(changedPaths: string[], iteration: number): string[] {
    this.threadsRevision++;
    const changed = new Set(changedPaths);
    const reset: string[] = [];
    for (const file of this.state.files) {
      if (!changed.has(file.path) || this.isCommittedFile(file)) {
        continue;
      }
      file.changedInIteration = iteration;
      // A part of a split file stays approved while its own changes are the same (see sync).
      if (file.status === 'done' && !this.isSplit(file.path)) {
        file.status = 'in-progress';
        file.approvedBlob = undefined;
        reset.push(file.path);
      }
    }
    return reset;
  }

  markCommitted(commitId: string, sha: string): PlanCommit | null {
    const commit = this.getCommit(commitId);
    commit.status = 'committed';
    commit.sha = sha;
    // Git's order: a commit made ahead of planned ones it doesn't build on moves up to just after
    // the commits already made.
    const others = this.commitsInOrder().filter((c) => c.id !== commitId);
    let at = 0;
    others.forEach((c, i) => {
      if (c.status === 'committed') {
        at = i + 1;
      }
    });
    others.splice(at, 0, commit);
    others.forEach((c, i) => {
      c.order = i + 1;
    });

    const next = this.commitsInOrder().find((c) => c.status !== 'committed') ?? null;
    this.state.session.currentCommitId = null;
    this.finishIfDone();
    this.threadsRevision++;
    return next;
  }

  /**
   * Files (or parts of split files) amended into a committed commit: they become part of its
   * history, joining the commit's own entry for the same file.
   */
  absorb(files: ReviewFile[], commitId: string): void {
    const commit = this.getCommit(commitId);
    if (commit.status !== 'committed') {
      throw new Error(`"${subjectOf(commit)}" is not committed.`);
    }
    for (const file of files) {
      const existing = this.state.files.find((f) => f.path === file.path && f.commitId === commitId);
      if (existing) {
        this.state.files.splice(this.state.files.indexOf(file), 1);
        continue;
      }
      file.commitId = commitId;
      file.status = 'done';
      file.hunks = undefined;
      file.part = undefined;
    }
    for (const filePath of new Set(files.map((f) => f.path))) {
      this.settleSplit(filePath);
    }
    this.threadsRevision++;
  }

  // ---- comment threads ----  // ---- comment threads ----

  getThread(threadId: string): ReviewThread {
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) {
      throw new Error(`Unknown thread ${threadId}.`);
    }
    return thread;
  }

  threadsOf(commitId: string): ReviewThread[] {
    return this.state.threads.filter((t) => t.commitId === commitId);
  }

  /** Comment threads on these files that are not resolved yet (explanations don't count). */
  unresolvedComments(paths: string[]): ReviewThread[] {
    const wanted = new Set(paths);
    return this.state.threads.filter((t) => t.kind === 'comment' && t.status !== 'resolved' && wanted.has(t.path));
  }

  /** Threads the AI is working on. */
  sentThreads(): ReviewThread[] {
    return this.state.threads.filter((t) => t.status === 'sent');
  }

  addThread(input: NewThread, now: string): ReviewThread {
    const file = this.findFile(input.path);
    if (!file || this.isCommittedFile(file)) {
      throw new Error(`${input.path} is not a pending file in this review.`);
    }
    if (!input.body.trim()) {
      throw new Error('Comment cannot be empty.');
    }
    const iteration = this.iterationFor(file.commitId);
    const thread: ReviewThread = {
      id: this.nextThreadId(),
      kind: input.kind,
      path: input.path,
      commitId: file.commitId,
      iteration,
      line: input.line,
      lineText: input.lineText,
      status: input.kind === 'comment' ? 'open' : 'answered',
      messages: [{ author: input.author, body: input.body.trim(), createdAt: now, iteration, model: input.model }],
      createdAt: now,
    };
    this.state.threads.push(thread);
    this.threadsRevision++;
    return thread;
  }

  /** The AI's note on a line: replaces an earlier explanation on the same line. */
  setExplanation(path: string, line: number, lineText: string, body: string, now: string, model?: string): ReviewThread {
    const existing = this.state.threads.find(
      (t) => t.kind === 'explanation' && t.path === path && t.line === line && t.status !== 'resolved',
    );
    if (!existing) {
      return this.addThread({ kind: 'explanation', path, line, lineText, body, author: 'ai', model }, now);
    }
    const iteration = this.iterationFor(existing.commitId);
    existing.lineText = lineText;
    existing.messages = [{ author: 'ai', body: body.trim(), createdAt: now, iteration, model }];
    this.threadsRevision++;
    return existing;
  }

  /**
   * Adds a message. A user reply reopens the thread (and turns an explanation into a comment);
   * an AI reply answers it, or resolves it when asked.
   */
  reply(threadId: string, author: MessageAuthor, body: string, resolve: boolean, now: string, model?: string): ReviewThread {
    const thread = this.getThread(threadId);
    if (!body.trim()) {
      throw new Error('Reply cannot be empty.');
    }
    thread.messages.push({
      author,
      body: body.trim(),
      createdAt: now,
      iteration: this.iterationFor(thread.commitId),
      model,
    });
    thread.error = undefined;
    if (author === 'user') {
      thread.kind = 'comment';
      thread.status = 'open';
    } else {
      thread.status = resolve ? 'resolved' : 'answered';
    }
    this.threadsRevision++;
    return thread;
  }

  setThreadResolved(threadId: string, resolved: boolean): void {
    const thread = this.getThread(threadId);
    thread.status = resolved ? 'resolved' : 'open';
    this.threadsRevision++;
  }

  /** Edits one of the user's own messages. */
  editMessage(threadId: string, index: number, body: string): void {
    const message = this.userMessage(threadId, index);
    if (!body.trim()) {
      throw new Error('Comment cannot be empty.');
    }
    message.body = body.trim();
    this.threadsRevision++;
  }

  /** Deletes one of the user's own messages; deleting the only message deletes the thread. */
  deleteMessage(threadId: string, index: number): void {
    const thread = this.getThread(threadId);
    this.userMessage(threadId, index);
    if (thread.messages.length === 1) {
      this.deleteThread(threadId);
      return;
    }
    thread.messages.splice(index, 1);
    this.threadsRevision++;
  }

  deleteThread(threadId: string): void {
    this.getThread(threadId);
    this.state.threads = this.state.threads.filter((t) => t.id !== threadId);
    this.threadsRevision++;
  }

  /**
   * Marks open comments as being answered by the AI: the given threads, or every open comment.
   * Returns the threads it marked.
   */
  startAsking(threadIds?: string[]): ReviewThread[] {
    const open = (threadIds ? threadIds.map((id) => this.getThread(id)) : this.state.threads).filter(
      (t) => t.kind === 'comment' && t.status === 'open',
    );
    if (open.length === 0) {
      throw new Error('There are no open comments to ask about.');
    }
    for (const thread of open) {
      thread.status = 'sent';
      thread.error = undefined;
    }
    this.threadsRevision++;
    return open;
  }

  /** The AI request failed or was cancelled: the thread goes back to open with the reason. */
  failAsking(threadId: string, error: string): void {
    const thread = this.getThread(threadId);
    thread.status = 'open';
    thread.error = error;
    this.threadsRevision++;
  }

  setShowExplanations(show: boolean): void {
    this.state.session.showExplanations = show;
    this.threadsRevision++;
  }

  // ---- helpers ----

  private editableCommit(commitId: string): PlanCommit {
    const commit = this.getCommit(commitId);
    if (commit.status === 'committed') {
      throw new Error('Committed commits cannot be changed.');
    }
    return commit;
  }

  /** Removes a commit from the plan, and from the commits that built on it. */
  private forgetCommit(commitId: string): void {
    this.state.commits = this.state.commits.filter((c) => c.id !== commitId);
    for (const commit of this.state.commits) {
      if (commit.dependsOn?.includes(commitId)) {
        const rest = commit.dependsOn.filter((id) => id !== commitId);
        commit.dependsOn = rest.length > 0 ? rest : undefined;
      }
    }
  }

  private userMessage(threadId: string, index: number) {
    const message = this.getThread(threadId).messages[index];
    if (!message) {
      throw new Error('Unknown message.');
    }
    if (message.author !== 'user') {
      throw new Error("Only your own messages can be changed. Delete the thread to remove the AI's.");
    }
    return message;
  }

  private isCommittedFile(file: ReviewFile): boolean {
    if (!file.commitId) {
      return false;
    }
    return this.state.commits.some((c) => c.id === file.commitId && c.status === 'committed');
  }

  private iterationFor(commitId: string | null): number {
    if (!commitId) {
      return 0;
    }
    return this.latestIteration(commitId)?.n ?? 0;
  }

  private nextThreadId(): string {
    const max = this.state.threads.reduce((highest, t) => {
      const n = Number(t.id.replace(/^t_/, ''));
      return Number.isFinite(n) ? Math.max(highest, n) : highest;
    }, 0);
    return `t_${String(max + 1).padStart(3, '0')}`;
  }

  private nextCommitId(): string {
    const max = this.state.commits.reduce((highest, c) => {
      const n = Number(c.id.replace(/^c_/, ''));
      return Number.isFinite(n) ? Math.max(highest, n) : highest;
    }, 0);
    return `c_${String(max + 1).padStart(2, '0')}`;
  }
}

/** Key of a file's part in its commit, for approvals of parts of split files. */
export function approvalKey(file: { path: string; commitId: string | null }): string {
  return `${file.commitId ?? ''}\0${file.path}`;
}

/** First line of the commit message. */
export function subjectOf(commit: PlanCommit): string {
  return commit.message.split('\n')[0].trim();
}

/**
 * Merges entries of one path that ended up in the same commit (or both Unassigned). Of two main
 * parts (a commit came back while the path had a new entry), the one in a commit stays.
 */
function mergeDuplicates(entries: ReviewFile[]): ReviewFile[] {
  const mains = entries.filter((f) => !f.hunks);
  if (mains.length > 1) {
    const keep = mains.find((f) => f.commitId) ?? mains[0];
    entries = entries.filter((f) => f.hunks || f === keep);
  }
  const byCommit = new Map<string | null, ReviewFile>();
  for (const file of entries) {
    const into = byCommit.get(file.commitId);
    if (!into) {
      byCommit.set(file.commitId, file);
      continue;
    }
    into.hunks = into.hunks && file.hunks ? [...into.hunks, ...file.hunks] : undefined;
    if (into.status === 'done') {
      into.status = 'in-progress';
      into.approvedBlob = undefined;
    }
  }
  return [...byCommit.values()];
}

/**
 * A file that can't be split (any more): one entry, the one in a commit when there is a choice. Its
 * blocks of changes come back to it.
 */
function collapse(entries: ReviewFile[]): ReviewFile[] {
  if (entries.length === 1 && !entries[0].hunks) {
    entries[0].part = undefined;
    return entries;
  }
  const whole = entries.find((f) => f.commitId && !f.hunks) ?? entries.find((f) => f.commitId) ?? entries[0];
  whole.hunks = undefined;
  whole.part = undefined;
  if (entries.length > 1 && whole.status === 'done') {
    whole.status = 'in-progress';
    whole.approvedBlob = undefined;
  }
  return [whole];
}

function newFile(change: FileChange): ReviewFile {
  return {
    path: change.path,
    commitId: null,
    status: 'todo',
    changeType: change.changeType,
    adds: change.adds,
    dels: change.dels,
    binary: change.binary,
  };
}
