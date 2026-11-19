import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import type { PlanInput } from '../core/types';

/**
 * Sift's tools for chat agents in VS Code (GitHub Copilot's agent mode, or any chat that uses
 * VS Code's language model tools): read the review, set the commit plan, explain lines, answer
 * comment threads. The agent edits code with its own tools; Sift keeps the review.
 */

/** Author of what the agent writes in threads. */
const AGENT = 'Chat agent';

interface ExplainInput {
  path: string;
  line: number;
  body: string;
}

interface ReplyInput {
  threadId: string;
  body: string;
  resolve?: boolean;
}

export function registerAgentTools(controller: ReviewController): vscode.Disposable {
  const text = (value: unknown) =>
    new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(typeof value === 'string' ? value : JSON.stringify(value, null, 2))]);

  return vscode.Disposable.from(
    vscode.lm.registerTool<Record<string, never>>('sift_getReview', {
      invoke: async () => text(await reviewSummary(controller)),
      prepareInvocation: () => ({ invocationMessage: 'Reading the Sift review' }),
    }),

    vscode.lm.registerTool<PlanInput>('sift_setPlan', {
      prepareInvocation: (options) => {
        const count = options.input.commits?.length ?? 0;
        const replaces = controller.review?.state.commits.some((c) => c.status !== 'committed') ?? false;
        return {
          invocationMessage: `Setting a plan of ${count} commit(s)`,
          confirmationMessages: replaces
            ? {
                title: 'Replace the Sift plan?',
                message: `The agent's plan of ${count} commit(s) replaces the commits that are not committed yet, with their approvals.`,
              }
            : undefined,
        };
      },
      invoke: async (options) => {
        await controller.setPlan(options.input, AGENT);
        const unassigned = controller.review?.filesOf(null).length ?? 0;
        return text(`Plan set: ${options.input.commits.length} commit(s), ${unassigned} file(s) left unassigned. The developer reviews it in the Sift view.`);
      },
    }),

    vscode.lm.registerTool<ExplainInput>('sift_explain', {
      prepareInvocation: (options) => ({ invocationMessage: `Explaining ${options.input.path}:${options.input.line}` }),
      invoke: async (options) => {
        const { path, line, body } = options.input;
        if (!controller.review?.findFile(path)) {
          throw new Error(`${path} is not part of the review: it has no uncommitted changes.`);
        }
        await controller.explain(path, line, body);
        return text(`Explanation added on ${path}:${line}.`);
      },
    }),

    vscode.lm.registerTool<ReplyInput>('sift_reply', {
      prepareInvocation: () => ({ invocationMessage: 'Answering a Sift comment' }),
      invoke: async (options) => {
        const { threadId, body, resolve } = options.input;
        const model = controller.review;
        if (!model?.state.threads.some((t) => t.id === threadId)) {
          throw new Error(`No comment thread ${threadId}. Call sift_getReview for the open ones.`);
        }
        // Code the agent changed for this answer gets its own version, so "latest change" shows it.
        if (model.currentCommit()) {
          await controller.takeSnapshot('ai');
        }
        await controller.replyAsAi(threadId, body, AGENT, resolve ?? false);
        return text(`Replied${resolve ? ' and resolved the thread' : ''}.`);
      },
    }),
  );
}

/** The review as the agent needs it: commits, files and their status, and comments waiting for an answer. */
async function reviewSummary(controller: ReviewController): Promise<unknown> {
  const model = controller.review;
  if (!model) {
    return 'No Sift review in this repository yet. Call sift_setPlan to split the uncommitted changes into commits; that starts one.';
  }
  const fileList = (commitId: string | null) =>
    model.filesOf(commitId).map((f) => ({ path: f.path, change: f.changeType, status: f.status }));
  const current = model.state.session.currentCommitId;
  return {
    commitInReview: current,
    commits: model.commitsInOrder().map((c) => ({
      id: c.id,
      order: c.order,
      message: c.message,
      status:
        c.status === 'committed'
          ? `${c.revertedBy ? 'reverted' : c.pushed ? 'pushed' : 'committed'} ${c.sha?.slice(0, 7) ?? ''}`.trim()
          : model.commitReviewStatus(c.id),
      buildsOn: model.dependenciesOf(c.id).map((d) => d.order),
      files: fileList(c.id),
    })),
    unassignedFiles: fileList(null),
    // Comments whose last word is the developer's: these wait for an answer.
    commentsToAnswer: model.state.threads
      .filter((t) => t.kind === 'comment' && t.status !== 'resolved' && t.status !== 'sent' && t.messages.at(-1)?.author === 'user')
      .map((t) => ({
        threadId: t.id,
        path: t.path,
        line: t.line + 1,
        lineText: t.lineText,
        messages: t.messages.map((m) => ({ author: m.author === 'user' ? 'developer' : 'ai', body: m.body })),
      })),
    howTo:
      'Answer each comment with sift_reply after making any code change it asks for (edit files with your own tools). File statuses and commits are the developer\'s to approve.',
  };
}
