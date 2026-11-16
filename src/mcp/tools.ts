import { z } from 'zod';
import type { FeedbackEvent, ReviewController } from '../controller/ReviewController';
import type { ReviewModel } from '../core/ReviewModel';
import type { PlanCommit, ReviewThread } from '../core/types';

export interface ToolContext {
  signal?: AbortSignal;
}

export interface ToolUi {
  /** Shows Claude's round summary to the user. */
  notify(message: string): void;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

const MAX_WAIT_SEC = 600;
const DEFAULT_WAIT_SEC = 240;

/** The tools Claude uses to drive the review. Claude never stages, commits or marks files done. */
export function buildTools(controller: ReviewController, ui: ToolUi): ToolDef[] {
  const model = (): ReviewModel => {
    const review = controller.review;
    if (!review) {
      throw new Error('No review session. Ask the user to click "Start review" in the Sift view.');
    }
    return review;
  };

  return [
    {
      name: 'review_get_status',
      description:
        'Current review state: session, commit in review, plan, whose turn it is, and the next step to take. Call this first, and whenever unsure what to do.',
      inputSchema: {},
      handler: async () => status(controller),
    },
    {
      name: 'review_get_changes',
      description: 'Changed files in the review with their commit assignment and review status.',
      inputSchema: {
        unassignedOnly: z.boolean().optional().describe('Only files not yet in any commit.'),
      },
      handler: async (args) => {
        await controller.refresh();
        const files = model()
          .state.files.filter((f) => !isCommitted(model(), f.commitId))
          .filter((f) => !args.unassignedOnly || f.commitId === null);
        return {
          files: files.map((f) => ({
            path: f.path,
            changeType: f.changeType,
            adds: f.adds,
            dels: f.dels,
            binary: f.binary,
            commitId: f.commitId,
            status: f.status,
          })),
        };
      },
    },
    {
      name: 'review_set_plan',
      description:
        'Replace the not-yet-committed plan. Group files into logical, atomic commits in a sensible order; each commit should build on its own. Every pending changed file must appear exactly once.',
      inputSchema: {
        commits: z
          .array(
            z.object({
              message: z.string().describe('Commit message (subject line, optional body after a blank line).'),
              intent: z.string().optional().describe('What this commit does and why, for the reviewer.'),
              riskNotes: z.array(z.string()).optional().describe('Spots the reviewer should read carefully.'),
              files: z.array(z.string()).describe('Repo-relative paths.'),
            }),
          )
          .min(1),
      },
      handler: async (args) => {
        await controller.setPlan({ commits: args.commits as never });
        return { ok: true, commits: model().commitsInOrder().map(commitSummary(model())) };
      },
    },
    {
      name: 'review_assign_files',
      description:
        'Move files to another commit (or to Unassigned with commitId null). Only do this after the user agreed in a comment thread.',
      inputSchema: {
        paths: z.array(z.string()).min(1),
        commitId: z.string().nullable(),
      },
      handler: async (args) => {
        await controller.moveFiles(args.paths as string[], (args.commitId as string | null) ?? null);
        return { ok: true };
      },
    },
    {
      name: 'review_start_commit',
      description:
        'Put a planned commit into review. Takes snapshot v0 and hands the turn to the user. Then add explanations with review_explain and call review_wait_for_feedback.',
      inputSchema: {
        commitId: z.string(),
      },
      handler: async (args) => {
        await controller.startCommit(args.commitId as string);
        return currentCommitDetails(model());
      },
    },
    {
      name: 'review_explain',
      description:
        'Attach a short explanation (intent, risk; 3 bullets max) to a line of a file in the review. Shown to the user as a Claude comment. Skip purely mechanical changes. A second call on the same line replaces the first.',
      inputSchema: {
        path: z.string(),
        line: z.number().int().min(1).describe('1-based line number in the current file.'),
        body: z.string().describe('Markdown.'),
      },
      handler: async (args) => {
        const thread = await controller.explain(args.path as string, args.line as number, args.body as string);
        return { threadId: thread.id };
      },
    },
    {
      name: 'review_wait_for_feedback',
      description:
        'Block until the user clicks "Send to Claude" (returns event "feedback" with the threads to address) or approves the commit (event "approved"). Returns event "none" on timeout: just call it again.',
      inputSchema: {
        timeoutSec: z.number().int().min(1).max(MAX_WAIT_SEC).optional().describe(`Default ${DEFAULT_WAIT_SEC}.`),
      },
      handler: async (args, context) => {
        const timeoutSec = (args.timeoutSec as number | undefined) ?? DEFAULT_WAIT_SEC;
        const event = await controller.waitForFeedback(timeoutSec * 1000, context.signal);
        return describeEvent(event);
      },
    },
    {
      name: 'review_get_feedback',
      description: 'Same result as review_wait_for_feedback, without waiting. Use it when resuming in a new session.',
      inputSchema: {},
      handler: async () => describeEvent(controller.pendingEvent()),
    },
    {
      name: 'review_reply',
      description:
        'Reply in a thread after handling it: say what you changed, or why not. Set resolve when the thread needs nothing more from the user.',
      inputSchema: {
        threadId: z.string(),
        body: z.string(),
        resolve: z.boolean().optional(),
      },
      handler: async (args) => {
        const thread = await controller.replyAsClaude(
          args.threadId as string,
          args.body as string,
          Boolean(args.resolve),
        );
        return { threadId: thread.id, status: thread.status };
      },
    },
    {
      name: 'review_mark_ready',
      description:
        'Call after applying all feedback and replying to each thread. Takes the next snapshot (vN+1) so the user sees only your changes, shows your summary, and hands the turn back to the user.',
      inputSchema: {
        summary: z.string().describe('What you changed this round, 3 bullets max.'),
      },
      handler: async (args) => {
        const version = await controller.markReady();
        ui.notify(String(args.summary));
        return {
          version,
          changed: version !== null,
          next: 'Call review_wait_for_feedback.',
        };
      },
    },
    {
      name: 'review_commit_done',
      description:
        'Acknowledge an approved commit after review_wait_for_feedback returned "approved". Returns the commit now in review, or done: true when every commit is committed.',
      inputSchema: {},
      handler: async () => {
        const approval = await controller.takeApproval();
        if (!approval) {
          throw new Error('The user has not approved a commit. Call review_wait_for_feedback.');
        }
        const review = model();
        if (!approval.nextCommitId) {
          return {
            committed: approval.sha,
            done: true,
            unassignedFiles: review.filesOf(null).length,
            next: 'Tell the user every planned commit is done and they can push.',
          };
        }
        return { committed: approval.sha, done: false, ...currentCommitDetails(review) };
      },
    },
  ];
}

function status(controller: ReviewController): unknown {
  const review = controller.review;
  if (!review) {
    return { session: null, next: 'Ask the user to click "Start review" in the Sift view.' };
  }
  const session = review.state.session;
  const commits = review.commitsInOrder();
  const current = review.currentCommit();
  const event = controller.pendingEvent();
  return {
    session: {
      id: session.id,
      status: session.status,
      baseCommit: session.baseCommit,
      turn: session.turn,
      statePath: controller.statePath,
    },
    commits: commits.map(commitSummary(review)),
    unassignedFiles: review.filesOf(null).length,
    currentCommit: current ? currentCommitDetails(review).commit : null,
    pendingEvent: event.event,
    next: nextStep(review, event, current),
  };
}

function nextStep(review: ReviewModel, event: FeedbackEvent, current: PlanCommit | null): string {
  if (review.state.session.status === 'done') {
    return 'All commits are done. Tell the user they can push.';
  }
  if (event.event === 'approved') {
    return 'The user approved a commit. Call review_commit_done.';
  }
  if (event.event === 'feedback') {
    return 'Apply each sent thread, reply with review_reply, then call review_mark_ready.';
  }
  if (review.state.commits.length === 0) {
    return 'Call review_get_changes, then review_set_plan.';
  }
  if (!current) {
    const next = review.commitsInOrder().find((c) => c.status !== 'committed');
    return next ? `Call review_start_commit with commitId "${next.id}".` : 'Assign the unassigned files to a commit.';
  }
  return 'Call review_wait_for_feedback.';
}

function commitSummary(review: ReviewModel) {
  return (commit: PlanCommit) => {
    const files = review.filesOf(commit.id);
    return {
      id: commit.id,
      order: commit.order,
      message: commit.message,
      status: commit.status,
      sha: commit.sha,
      files: files.length,
      done: files.filter((f) => f.status === 'done').length,
    };
  };
}

function currentCommitDetails(review: ReviewModel) {
  const commit = review.currentCommit();
  if (!commit) {
    return { commit: null };
  }
  return {
    commit: {
      id: commit.id,
      message: commit.message,
      intent: commit.intent,
      riskNotes: commit.riskNotes,
      version: review.latestIteration(commit.id)?.n ?? null,
      files: review.filesOf(commit.id).map((f) => ({
        path: f.path,
        changeType: f.changeType,
        status: f.status,
        adds: f.adds,
        dels: f.dels,
      })),
    },
  };
}

function describeEvent(event: FeedbackEvent): unknown {
  if (event.event === 'feedback') {
    return {
      event: 'feedback',
      commitId: event.commitId,
      threads: event.threads.map(threadForClaude),
      next: 'Apply each thread, reply with review_reply, then call review_mark_ready.',
    };
  }
  if (event.event === 'approved') {
    return { event: 'approved', ...event.approval, next: 'Call review_commit_done.' };
  }
  return { event: 'none', next: 'Nothing yet. Call review_wait_for_feedback again.' };
}

function threadForClaude(thread: ReviewThread) {
  return {
    threadId: thread.id,
    path: thread.path,
    line: thread.line + 1,
    lineText: thread.lineText,
    startedOnVersion: thread.iteration,
    messages: thread.messages.map((m) => ({ author: m.author, body: m.body, version: m.iteration })),
  };
}

function isCommitted(review: ReviewModel, commitId: string | null): boolean {
  if (!commitId) {
    return false;
  }
  return review.state.commits.some((c) => c.id === commitId && c.status === 'committed');
}
