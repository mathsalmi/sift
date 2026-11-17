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
      version: 1,
      session: {
        id: sessionId,
        baseCommit: head,
        lastHead: head,
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

  // ---- changes from disk ----

  /** Brings the file list in line with the working tree; files of committed commits are kept as history. */
  syncChanges(changes: FileChange[]): void {
    const byPath = new Map(changes.map((c) => [c.path, c]));
    const kept: ReviewFile[] = [];

    for (const file of this.state.files) {
      if (this.isCommittedFile(file)) {
        // History entry. If the same path changed again, it gets a new pending entry below.
        kept.push(file);
        continue;
      }
      const change = byPath.get(file.path);
      if (!change) {
        continue; // reverted: no longer changed
      }
      file.changeType = change.changeType;
      file.adds = change.adds;
      file.dels = change.dels;
      file.binary = change.binary;
      kept.push(file);
      byPath.delete(file.path);
    }

    for (const change of byPath.values()) {
      kept.push(newFile(change));
    }

    this.state.files = kept;
  }

  setHead(head: string): void {
    this.state.session.lastHead = head;
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

  setStatus(paths: string[], status: FileStatus): void {
    for (const filePath of paths) {
      const file = this.findFile(filePath);
      if (!file || this.isCommittedFile(file)) {
        continue;
      }
      file.status = status;
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
        reset.push(file.path);
      }
    }
    return reset;
  }

  markCommitted(commitId: string, sha: string): PlanCommit | null {
    const commit = this.getCommit(commitId);
    commit.status = 'committed';
    commit.sha = sha;
    this.state.session.lastHead = sha;

    const next = this.commitsInOrder().find((c) => c.status !== 'committed') ?? null;
    this.state.session.currentCommitId = null;
    if (!next && this.filesOf(null).length === 0) {
      this.state.session.status = 'done';
    }
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
