import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';
import { resolveAnchor } from '../core/anchor';
import type { ReviewThread, ThreadMessage, ThreadStatus } from '../core/types';

const STATUS_LABEL: Record<ThreadStatus, string> = {
  open: 'Not asked yet',
  sent: 'AI is answering…',
  answered: 'AI answered',
  resolved: 'Resolved',
};

export interface Avatars {
  you: vscode.Uri;
  ai: vscode.Uri;
}

function markdown(text: string): vscode.MarkdownString {
  const body = new vscode.MarkdownString(text);
  body.supportThemeIcons = true;
  return body;
}

/** One message of a thread. The user's own messages can be edited and deleted. */
export class ThreadComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;
  readonly author: vscode.CommentAuthorInformation;
  readonly label: string | undefined;
  readonly timestamp: Date;
  readonly contextValue: string;
  parent: vscode.CommentThread | undefined;

  constructor(
    readonly threadId: string,
    readonly index: number,
    private readonly message: ThreadMessage,
    avatars: Avatars,
    /** The file's version when the message was written; shown once the file has more than one. */
    version: number | null,
  ) {
    this.body = markdown(message.body);
    this.author =
      message.author === 'ai'
        ? { name: message.model ?? 'AI', iconPath: avatars.ai }
        : { name: 'You', iconPath: avatars.you };
    this.label = version === null ? undefined : `v${version}`;
    this.timestamp = new Date(message.createdAt);
    this.contextValue = message.author === 'user' ? 'own' : 'ai';
  }

  /** The message as written (Markdown source), for copying. */
  get rawText(): string {
    return this.message.body;
  }

  get text(): string {
    return typeof this.body === 'string' ? this.body : this.body.value;
  }

  setEditing(editing: boolean): void {
    this.mode = editing ? vscode.CommentMode.Editing : vscode.CommentMode.Preview;
    this.body = editing ? this.message.body : markdown(this.message.body);
    if (this.parent) {
      // Reassigning makes VS Code redraw the thread.
      this.parent.comments = [...this.parent.comments];
    }
  }
}

/**
 * Renders review threads with the native Comments API on working-tree files,
 * and turns the user's comment UI actions into controller calls.
 */
export class CommentsManager implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  /** Review thread id → the VS Code thread showing it. Threads are updated in place, so the editor doesn't jump. */
  private rendered = new Map<string, vscode.CommentThread>();
  private readonly renderedStatus = new Map<string, string>();
  /** Threads the user just opened in the gutter, waiting to be adopted by the review thread they became. */
  private drafts: vscode.CommentThread[] = [];
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private renderedRevision = -1;
  private renderedSession: string | null = null;
  private renderChain: Promise<void> = Promise.resolve();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly review: ReviewController,
    private readonly avatars: Avatars,
    /** Name of the AI that will answer, for the "thinking" message. */
    private readonly aiName: () => string,
  ) {
    this.controller = vscode.comments.createCommentController('sift', 'Sift');
    const submit = process.platform === 'darwin' ? '⌘Enter' : 'Ctrl+Enter';
    this.controller.options = {
      prompt: 'Ask the AI about this line, or tell it what to change',
      placeHolder: `A question or a direction for the AI. Markdown works. ${submit} asks the AI.`,
    };
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

  /** First message of a new thread the user opened in the gutter. Returns the thread id. */
  async create(reply: vscode.CommentReply): Promise<string> {
    const uri = reply.thread.uri;
    const filePath = this.relativePath(uri);
    const line = reply.thread.range?.start.line ?? 0;
    if (!filePath) {
      reply.thread.dispose();
      throw new Error('Comments can only be added to files in the review.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const lineText = line < document.lineCount ? document.lineAt(line).text : '';
    // Keep the thread the user typed in; the next render fills it instead of drawing a new one.
    this.drafts.push(reply.thread);
    try {
      const thread = await this.review.addComment(filePath, line, lineText, reply.text);
      return thread.id;
    } catch (error) {
      this.drafts = this.drafts.filter((d) => d !== reply.thread);
      reply.thread.dispose();
      throw error;
    }
  }

  /** A new message in a new or existing thread. Returns the thread id. */
  async reply(reply: vscode.CommentReply): Promise<string> {
    const id = this.ids.get(reply.thread);
    if (!id) {
      return this.create(reply);
    }
    await this.review.replyAsUser(id, reply.text);
    return id;
  }

  threadId(thread: vscode.CommentThread): string | undefined {
    return this.ids.get(thread);
  }

  async copy(comment: ThreadComment): Promise<void> {
    await vscode.env.clipboard.writeText(comment.rawText);
    void vscode.window.setStatusBarMessage('$(copy) Message copied', 2000);
  }

  startEdit(comment: ThreadComment): void {
    comment.setEditing(true);
  }

  cancelEdit(comment: ThreadComment): void {
    comment.setEditing(false);
  }

  async saveEdit(comment: ThreadComment): Promise<void> {
    await this.review.editMessage(comment.threadId, comment.index, comment.text);
  }

  async deleteMessage(comment: ThreadComment): Promise<void> {
    await this.review.deleteMessage(comment.threadId, comment.index);
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

    const next = new Map<string, vscode.CommentThread>();
    const linesCache = new Map<string, string[]>();
    for (const thread of visible) {
      let lines = linesCache.get(thread.path);
      if (!lines) {
        lines = await this.readLines(thread.path);
        linesCache.set(thread.path, lines);
      }
      next.set(thread.id, this.showThread(thread, lines));
    }
    for (const [id, vsThread] of this.rendered) {
      if (!next.has(id)) {
        vsThread.dispose();
        this.renderedStatus.delete(id);
      }
    }
    this.rendered = next;
  }

  /** Updates the VS Code thread of a review thread, creating it (or adopting the user's draft) when needed. */
  private showThread(thread: ReviewThread, lines: string[]): vscode.CommentThread {
    const anchor = resolveAnchor(lines, thread.line, thread.lineText);
    const uri = vscode.Uri.file(path.join(this.review.root, ...thread.path.split('/')));
    const range = new vscode.Range(anchor.line, 0, anchor.line, 0);

    let vsThread = this.rendered.get(thread.id);
    if (vsThread && vsThread.uri.fsPath !== uri.fsPath) {
      vsThread.dispose();
      vsThread = undefined;
    }
    const isNew = !vsThread;
    if (!vsThread) {
      const draft = this.drafts.find((d) => d.uri.fsPath === uri.fsPath && d.range?.start.line === anchor.line);
      if (draft) {
        this.drafts = this.drafts.filter((d) => d !== draft);
      }
      vsThread = draft ?? this.controller.createCommentThread(uri, range, []);
    }
    if (vsThread.range?.start.line !== anchor.line) {
      vsThread.range = range;
    }

    const model = this.review.review;
    // The file's own version numbers, shown once it has more than one.
    const versionAt = (n: number) => model?.fileVersionAt(thread.commitId, thread.path, n) ?? n;
    const showVersions = (model?.fileVersions(thread.commitId, thread.path).length ?? 0) > 1;
    const comments = thread.messages.map(
      (m, index) => new ThreadComment(thread.id, index, m, this.avatars, showVersions ? versionAt(m.iteration) : null),
    );
    const shown: vscode.Comment[] = [...comments];
    if (thread.status === 'sent') {
      // A placeholder answer, so the thread shows the AI is working on it.
      shown.push({
        body: markdown('$(loading~spin) Thinking…'),
        mode: vscode.CommentMode.Preview,
        author: { name: this.aiName(), iconPath: this.avatars.ai },
        contextValue: 'thinking',
      });
    }
    vsThread.comments = shown;
    for (const comment of comments) {
      comment.parent = vsThread;
    }

    let kindLabel = thread.kind === 'explanation' ? 'AI explains' : STATUS_LABEL[thread.status];
    if (thread.error && thread.status === 'open') {
      kindLabel = `AI couldn't answer: ${thread.error}`;
    }
    vsThread.label = anchor.outdated ? `${kindLabel} · outdated (from v${versionAt(thread.iteration)})` : kindLabel;
    vsThread.contextValue = `${thread.kind}-${thread.status}`;
    vsThread.canReply = true;
    vsThread.state =
      thread.status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    // Only open or close the thread when it appears or gets (un)resolved, never while the user is in it.
    const wasResolved = this.renderedStatus.get(thread.id) === 'resolved';
    if (isNew || wasResolved !== (thread.status === 'resolved')) {
      vsThread.collapsibleState =
        thread.kind === 'explanation' || thread.status === 'resolved'
          ? vscode.CommentThreadCollapsibleState.Collapsed
          : vscode.CommentThreadCollapsibleState.Expanded;
    }
    this.renderedStatus.set(thread.id, thread.status);
    this.ids.set(vsThread, thread.id);
    return vsThread;
  }

  private clear(): void {
    for (const thread of [...this.rendered.values(), ...this.drafts]) {
      thread.dispose();
    }
    this.rendered = new Map();
    this.renderedStatus.clear();
    this.drafts = [];
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
