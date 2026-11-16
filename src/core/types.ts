export type FileStatus = 'todo' | 'in-progress' | 'done';
export type CommitStatus = 'planned' | 'in-review' | 'committed';
export type ChangeType = 'added' | 'modified' | 'deleted';
export type IterationAuthor = 'initial' | 'claude' | 'user';
export type Turn = 'user' | 'claude';
export type ThreadKind = 'comment' | 'explanation';
export type ThreadStatus = 'open' | 'sent' | 'answered' | 'resolved';
export type MessageAuthor = 'user' | 'claude';

export interface PendingApproval {
  commitId: string;
  sha: string;
  nextCommitId: string | null;
}

export interface Session {
  id: string;
  /** HEAD when the session started. */
  baseCommit: string;
  /** HEAD as last seen by the extension; used to detect commits made outside it. */
  lastHead: string;
  currentCommitId: string | null;
  status: 'active' | 'done';
  createdAt: string;
  /** Whose move it is in the review loop. */
  turn: Turn;
  showExplanations: boolean;
  /** Set when the user approves a commit; delivered to Claude by review_wait_for_feedback. */
  pendingApproval: PendingApproval | null;
}

export interface PlanCommit {
  id: string;
  order: number;
  message: string;
  intent: string;
  riskNotes: string[];
  status: CommitStatus;
  sha?: string;
}

export interface ReviewFile {
  path: string;
  /** null = Unassigned. */
  commitId: string | null;
  status: FileStatus;
  changeType: ChangeType;
  adds: number | null;
  dels: number | null;
  binary: boolean;
  /** Set when a new snapshot changed this file; shown as "changed in vN". */
  changedInIteration?: number;
}

export interface Iteration {
  n: number;
  commitId: string;
  treeSha: string;
  commitSha: string;
  ref: string;
  author: IterationAuthor;
  createdAt: string;
}

export interface ThreadMessage {
  author: MessageAuthor;
  body: string;
  createdAt: string;
  iteration: number;
}

export interface ReviewThread {
  id: string;
  kind: ThreadKind;
  path: string;
  commitId: string | null;
  /** Version the thread was started on. */
  iteration: number;
  /** 0-based line in the working tree when the thread was anchored. */
  line: number;
  /** Text of that line, used to re-anchor after edits. */
  lineText: string;
  status: ThreadStatus;
  messages: ThreadMessage[];
  createdAt: string;
}

export interface ReviewState {
  version: 1;
  session: Session;
  commits: PlanCommit[];
  files: ReviewFile[];
  iterations: Iteration[];
  threads: ReviewThread[];
}

/** Shape of .sift/plan.json, written by Claude or by hand. */
export interface PlanInput {
  commits: Array<{
    message: string;
    intent?: string;
    riskNotes?: string[];
    files: string[];
  }>;
}
