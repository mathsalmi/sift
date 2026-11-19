import type { FileChange } from '../git/changes';
import type {
  CommitReviewStatus,
  FileStatus,
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

  /** The pending entry for a path when there is one, else its committed history entry. */
  findFile(filePath: string): ReviewFile | undefined {
    const matches = this.state.files.filter((f) => f.path === filePath);
    return matches.find((f) => !this.isCommittedFile(f)) ?? matches[0];
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
  adjacentFile(filePath: string, delta: -1 | 1): ReviewFile | null {
    const file = this.findFile(filePath);
    if (!file) {
      return null;
    }
    const files = this.filesOf(file.commitId);
    const index = files.findIndex((f) => f.path === filePath);
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
    const commit = this.getCommit(commitId);
    if (commit.status === 'committed') {
      return 'This commit is already committed.';
    }
    if (!commit.message.trim()) {
      return 'The commit has no message.';
    }
    const files = this.filesOf(commitId);
    if (files.length === 0) {
      return 'The commit has no files.';
    }
    const pending = files.filter((f) => f.status !== 'done').length;
    if (pending > 0) {
      return `${pending} file(s) in this commit are not approved yet.`;
    }
    return null;
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
          this.state.commits = this.state.commits.filter((c) => c.id !== commit.id);
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

    // Files: history of committed commits, then one pending entry per changed path.
    const owners = new Map<string, ReviewFile>();
    for (const file of this.state.files) {
      if (this.isCommittedFile(file) || !changed.has(file.path)) {
        continue;
      }
      const owner = owners.get(file.path);
      // Two pending entries for a path (a commit came back while the path had a new entry): keep the planned one.
      if (!owner || (!owner.commitId && file.commitId)) {
        owners.set(file.path, file);
      }
    }
    const kept: ReviewFile[] = [];
    for (const file of this.state.files) {
      if (this.isCommittedFile(file)) {
        file.status = 'done';
        kept.push(file);
        continue;
      }
      if (owners.get(file.path) !== file) {
        continue; // no longer changed, or a duplicate
      }
      const change = changed.get(file.path)!;
      file.changeType = change.changeType;
      file.adds = change.adds;
      file.dels = change.dels;
      file.binary = change.binary;
      kept.push(file);
    }
    for (const change of facts.changes) {
      if (!owners.has(change.path)) {
        kept.push(newFile(change));
      }
    }
    this.state.files = kept;

    // Approvals hold only for the content that was approved.
    for (const file of kept) {
      if (file.status !== 'done' || this.isCommittedFile(file)) {
        continue;
      }
      const blob = facts.blobs.get(file.path);
      if (blob === undefined) {
        continue;
      }
      if (file.approvedBlob === undefined) {
        file.approvedBlob = blob; // approved before approvals were tied to content
      } else if (file.approvedBlob !== blob) {
        file.status = 'in-progress';
        file.approvedBefore = file.approvedBlob;
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
    this.state.commits = [...committed];
    for (const file of this.state.files) {
      if (!this.isCommittedFile(file)) {
        file.commitId = null;
      }
    }
    if (this.state.session.currentCommitId && !committed.some((c) => c.id === this.state.session.currentCommitId)) {
      this.state.session.currentCommitId = null;
    }

    for (const input of plan.commits) {
      const commit = this.addCommit(input.message, input.intent ?? '', input.riskNotes ?? []);
      for (const filePath of input.files) {
        const file = this.findFile(filePath);
        if (file) {
          file.commitId = commit.id;
        }
      }
    }

    // Explanations of the old plan go away (the new plan brings its own); the user's comments follow their file.
    this.state.threads = this.state.threads.filter(
      (t) => (t.commitId !== null && committedIds.has(t.commitId)) || t.kind === 'comment',
    );
    for (const thread of this.state.threads) {
      if (thread.commitId === null || !committedIds.has(thread.commitId)) {
        thread.commitId = this.findFile(thread.path)?.commitId ?? null;
      }
    }
    this.threadsRevision++;

    return { unassigned: this.filesOf(null).length };
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
    for (const file of this.filesOf(commitId)) {
      file.commitId = null;
    }
    this.state.commits = this.state.commits.filter((c) => c.id !== commitId);
    if (this.state.session.currentCommitId === commitId) {
      this.state.session.currentCommitId = null;
    }
  }

  /** Swaps the commit with its neighbour; committed commits stay where they are. */
  moveCommit(commitId: string, delta: -1 | 1): void {
    const commit = this.editableCommit(commitId);
    const ordered = this.commitsInOrder();
    const index = ordered.findIndex((c) => c.id === commitId);
    const neighbour = ordered.at(index + delta);
    if (index + delta < 0 || !neighbour || neighbour.status === 'committed') {
      return;
    }
    [commit.order, neighbour.order] = [neighbour.order, commit.order];
  }

  moveFiles(paths: string[], commitId: string | null): void {
    if (commitId) {
      this.editableCommit(commitId);
    }
    for (const filePath of paths) {
      const file = this.findFile(filePath);
      if (!file || this.isCommittedFile(file)) {
        continue;
      }
      file.commitId = commitId;
    }
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

  /** `blobs`: content ids of the files now, so an approval covers exactly this content. */
  setStatus(paths: string[], status: FileStatus, blobs?: Map<string, string>): void {
    for (const filePath of paths) {
      const file = this.findFile(filePath);
      if (!file || this.isCommittedFile(file)) {
        continue;
      }
      file.status = status;
      file.changedSinceApproval = undefined;
      file.approvedBefore = undefined;
      file.approvedBlob = status === 'done' ? blobs?.get(filePath) : undefined;
      if (status === 'done') {
        file.changedInIteration = undefined;
      }
    }
  }

  /** Opening a file to review moves it from to do to in progress. */
  markOpened(filePath: string): boolean {
    const file = this.findFile(filePath);
    if (!file || file.status !== 'todo' || this.isCommittedFile(file)) {
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
      if (file.status === 'done') {
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

    const next = this.commitsInOrder().find((c) => c.status !== 'committed') ?? null;
    this.state.session.currentCommitId = null;
    this.finishIfDone();
    this.threadsRevision++;
    return next;
  }

  // ---- comment threads ----

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
