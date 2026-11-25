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
  /** HEAD when the session started; commits after it are searched for planned commits made outside Sift. */
  baseCommit: string;
  currentCommitId: string | null;
  status: 'active' | 'done';
  createdAt: string;
  showExplanations: boolean;
}

export interface PlanCommit {
  id: string;
  order: number;
  message: string;
  intent: string;
  riskNotes: string[];
  /** Derived, never saved: committed when git's history has it, in review when it is the current commit. */
  status: CommitStatus;
  /** Derived, never saved: the git commit it became (recorded in a private ref, see git/history.ts). */
  sha?: string;
  /** Derived, never saved: a remote branch has the commit, so it can be reverted but not undone. */
  pushed?: boolean;
  /** Derived, never saved: the git commit that reverted it (recorded in a private ref, see git/history.ts). */
  revertedBy?: string;
  /**
   * Planned commits this one builds on. They must come before it in the plan and be committed
   * first; reordering never puts it ahead of them.
   */
  dependsOn?: string[];
}

export interface ReviewFile {
  path: string;
  /** null = Unassigned. */
  commitId: string | null;
  status: FileStatus;
  /** Git's content id of the file when it was approved; the approval holds only while the content is the same. */
  approvedBlob?: string;
  /** The file changed after it was approved, so it went back to In progress. */
  changedSinceApproval?: boolean;
  /** With `changedSinceApproval`: git's content id of what was approved, to diff against what changed since. */
  approvedBefore?: string;
  /** Derived from git, never saved (as are the line counts and `binary`). */
  changeType: ChangeType;
  adds: number | null;
  dels: number | null;
  binary: boolean;
  /** Set when a new snapshot changed this file (snapshot number); shown as "changed in vK" with the file's own version. */
  changedInIteration?: number;
  /**
   * Set on a part of a file split across commits: the blocks of changes (see git/hunks.ts) this part
   * holds. A file has one entry per commit it is split across; the one without `hunks` holds the
   * changes no other part holds.
   */
  hunks?: HunkRef[];
  /** Derived, never saved: for a part of a split file, how many of the file's changes it holds. */
  part?: { own: number; total: number };
}

/** A block of changes held by a part of a split file, with where it was last seen in the working tree. */
export interface HunkRef {
  key: string;
  start: number;
  lines: number;
}

/** A file of the review, or with `commitId` its part in that commit (for files split across commits). */
export interface FileRef {
  path: string;
  /** Left out: the file's part in the commit in review, else its main part. */
  commitId?: string | null;
}

/**
 * A snapshot of the working tree while a commit is in review (n counts the commit's snapshots).
 * Files get their own version numbers from these: a file's version only goes up in a snapshot that changed it.
 */
export interface Iteration {
  n: number;
  /** Paths that differ from the commit's previous snapshot; absent on the first. */
  changed?: string[];
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
  /** 2: facts git knows (file changes, committed commits) are no longer saved. */
  version: 2;
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

/** Part of a file's changes in a plan: the blocks of changes these working-tree lines touch. */
export interface PlanFilePart {
  path: string;
  /** 1-based line ranges, [first, last], or a single line. A deletion is at the line just above where it was. */
  lines: Array<number | [number, number]>;
}

/** Shape of a plan: from the AI, or .sift/plan.json written by hand. */
export interface PlanInput {
  commits: Array<{
    message: string;
    intent?: string;
    riskNotes?: string[];
    /**
     * Whole files by path, or part of a file's changes: `lines` are 1-based line ranges of the
     * working-tree file, and the part holds every block of changes they touch. A file split this
     * way is listed in each commit that gets a part of it; a listing without `lines` takes the rest.
     */
    files: Array<string | PlanFilePart>;
    explanations?: PlanExplanation[];
    /** 1-based positions of earlier commits in this plan that this one builds on. */
    dependsOn?: number[];
  }>;
}
