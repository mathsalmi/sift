import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import { resolveAnchor } from '../core/anchor';
import type { ReviewThread, ThreadMessage, ThreadStatus } from '../core/types';

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Open',
  sent: 'Sent to Claude',
  answered: 'Answered',
  resolved: 'Resolved',
};

class ThreadComment implements vscode.Comment {
  readonly mode = vscode.CommentMode.Preview;
  readonly body: vscode.MarkdownString;
  readonly author: vscode.CommentAuthorInformation;
  readonly label: string;

  constructor(message: ThreadMessage) {
    this.body = new vscode.MarkdownString(message.body);
    this.author = { name: message.author === 'claude' ? 'Claude' : 'You' };
    this.label = `v${message.iteration}`;
  }
}

/**
 * Renders review threads with the native Comments API on working-tree files,
 * and turns the user's comment UI actions into controller calls.
 */
export class CommentsManager implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private rendered: vscode.CommentThread[] = [];
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private renderedRevision = -1;
  private renderedSession: string | null = null;
  private renderChain: Promise<void> = Promise.resolve();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly review: ReviewController) {
    this.controller = vscode.comments.createCommentController('sift', 'Sift');
    this.controller.options = { prompt: 'Comment for Claude…', placeHolder: 'What should change here?' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.commentingRanges(document),
    };
    this.subscription = review.onDidChange(() => {
      void this.renderIfChanged();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.clear();
    this.controller.dispose();
  }

  // ---- actions from the comment UI (wired in extension.ts) ----

  /** First message of a new thread the user opened in the gutter. */
  async create(reply: vscode.CommentReply): Promise<void> {
    const uri = reply.thread.uri;
    const filePath = this.relativePath(uri);
    const line = reply.thread.range?.start.line ?? 0;
    if (!filePath) {
      reply.thread.dispose();
      throw new Error('Comments can only be added to files in the review.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const lineText = line < document.lineCount ? document.lineAt(line).text : '';
    reply.thread.dispose();
    await this.review.addComment(filePath, line, lineText, reply.text);
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const id = this.ids.get(reply.thread);
    if (!id) {
      await this.create(reply);
      return;
    }
    await this.review.replyAsUser(id, reply.text);
  }

  async resolve(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const id = this.ids.get(thread);
    if (id) {
      await this.review.setThreadResolved(id, resolved);
    }
  }

  async delete(thread: vscode.CommentThread): Promise<void> {
    const id = this.ids.get(thread);
    if (!id) {
      thread.dispose();
      return;
    }
    await this.review.deleteThread(id);
  }

  /** Forces a re-render, e.g. after files changed on disk and anchors may have moved. */
  async rerender(): Promise<void> {
    this.renderedRevision = -1;
    await this.renderIfChanged();
  }

  // ---- rendering ----

  /** Renders are serialized so overlapping change events never leave duplicate threads. */
  private renderIfChanged(): Promise<void> {
    this.renderChain = this.renderChain.then(() => this.render()).catch(() => undefined);
    return this.renderChain;
  }

  private async render(): Promise<void> {
    const model = this.review.review;
    if (!model) {
      this.clear();
      this.renderedRevision = -1;
      this.renderedSession = null;
      return;
    }
    if (model.threadsRevision === this.renderedRevision && model.state.session.id === this.renderedSession) {
      return;
    }
    this.renderedRevision = model.threadsRevision;
    this.renderedSession = model.state.session.id;

    const committed = new Set(model.state.commits.filter((c) => c.status === 'committed').map((c) => c.id));
    const visible = model.state.threads.filter((t) => {
      if (t.commitId && committed.has(t.commitId)) {
        return false;
      }
      return t.kind === 'comment' || model.state.session.showExplanations;
    });

    const next: vscode.CommentThread[] = [];
    const linesCache = new Map<string, string[]>();
    for (const thread of visible) {
      let lines = linesCache.get(thread.path);
      if (!lines) {
        lines = await this.readLines(thread.path);
        linesCache.set(thread.path, lines);
      }
      next.push(this.createThread(thread, lines));
    }

    this.clear();
    this.rendered = next;
  }

  private createThread(thread: ReviewThread, lines: string[]): vscode.CommentThread {
    const anchor = resolveAnchor(lines, thread.line, thread.lineText);
    const uri = vscode.Uri.file(path.join(this.review.root, ...thread.path.split('/')));
    const range = new vscode.Range(anchor.line, 0, anchor.line, 0);
    const comments = thread.messages.map((m) => new ThreadComment(m));
    const vsThread = this.controller.createCommentThread(uri, range, comments);

    const kindLabel = thread.kind === 'explanation' ? 'Claude explains' : STATUS_LABEL[thread.status];
    vsThread.label = anchor.outdated ? `${kindLabel} · outdated (from v${thread.iteration})` : kindLabel;
    vsThread.contextValue = `${thread.kind}-${thread.status}`;
    vsThread.canReply = true;
    vsThread.state =
      thread.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    vsThread.collapsibleState =
      thread.status === 'open' || thread.status === 'answered'
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
    if (thread.kind === 'explanation') {
      vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
    this.ids.set(vsThread, thread.id);
    return vsThread;
  }

  private clear(): void {
    for (const thread of this.rendered) {
      thread.dispose();
    }
    this.rendered = [];
  }

  private commentingRanges(document: vscode.TextDocument): vscode.Range[] {
    const filePath = this.relativePath(document.uri);
    if (!filePath) {
      return [];
    }
    return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
  }

  private relativePath(uri: vscode.Uri): string | null {
    const model = this.review.review;
    if (!model || uri.scheme !== 'file') {
      return null;
    }
    const relative = path.relative(this.review.root, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    const filePath = relative.split(path.sep).join('/');
    return model.findFile(filePath) ? filePath : null;
  }

  private async readLines(filePath: string): Promise<string[]> {
    const content = await fs.readFile(path.join(this.review.root, ...filePath.split('/')), 'utf8').catch(() => '');
    return content.split(/\r?\n/);
  }
}
