export type FileStatus = 'todo' | 'in-progress' | 'done';
export type CommitStatus = 'planned' | 'in-review' | 'committed';
/** Derived from the files: none approved, some approved, all approved; or already committed. */
export type CommitReviewStatus = 'todo' | 'in-progress' | 'approved' | 'committed';
export type ChangeType = 'added' | 'modified' | 'deleted';
export type IterationAuthor = 'initial' | 'ai' | 'user';
export type ThreadKind = 'comment' | 'explanation';
/** sent = the AI is working on it. */
export type ThreadStatus = 'open' | 'sent' | 'answered' | 'resolved';
export type MessageAuthor = 'user' | 'ai';

export interface Session {
  id: string;
  /** HEAD when the session started. */
  baseCommit: string;
  /** HEAD as last seen by the extension; used to detect commits made outside it. */
  lastHead: string;
  currentCommitId: string | null;
  status: 'active' | 'done';
  createdAt: string;
  showExplanations: boolean;
  /** Hash of the .sift/plan.json content last applied or dismissed, so a plan file is picked up once. */
  planFileHash?: string;
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
  /** Name of the model that wrote an AI message. */
  model?: string;
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
  /** Why the last AI request on this thread failed. */
  error?: string;
}

export interface ReviewState {
  version: 1;
  session: Session;
  commits: PlanCommit[];
  files: ReviewFile[];
  iterations: Iteration[];
  threads: ReviewThread[];
}

/** The AI's note on a line, shipped with the plan. */
export interface PlanExplanation {
  path: string;
  /** 1-based line in the current file. */
  line: number;
  body: string;
}

/** Shape of a plan: from the AI, or .sift/plan.json written by hand. */
export interface PlanInput {
  commits: Array<{
    message: string;
    intent?: string;
    riskNotes?: string[];
    files: string[];
    explanations?: PlanExplanation[];
  }>;
}
