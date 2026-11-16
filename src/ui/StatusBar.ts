import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';

/** "Review: Commit 3/14 · v2 · 212/500 files · this round" */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: ReviewController) {
    this.item.command = 'sift.nextTodo';
    this.subscription = controller.onDidChange(() => this.render());
    this.render();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private render(): void {
    const model = this.controller.review;
    if (!model) {
      this.item.hide();
      return;
    }
    const p = model.progress();
    const parts = ['$(checklist) Review'];
    if (model.state.session.status === 'done') {
      parts.push('done');
    } else if (p.currentIndex !== null) {
      parts.push(`Commit ${p.currentIndex + 1}/${p.commitCount}`);
      if (p.currentIteration !== null) {
        parts.push(`v${p.currentIteration}`);
      }
    } else {
      parts.push(`${p.committedCommits}/${p.commitCount} committed`);
    }
    parts.push(`${p.doneFiles}/${p.totalFiles} files`);
    parts.push(this.controller.diffMode === 'round' ? 'this round' : 'cumulative');
    if (model.state.session.currentCommitId) {
      if (model.state.session.turn === 'claude') {
        parts.push('$(sync~spin) Claude working');
      } else if (this.controller.claudeIsWaiting) {
        parts.push('$(bell) Claude is waiting for you');
      } else {
        parts.push('your turn');
      }
    }
    this.item.text = parts.join(' · ');
    this.item.tooltip = this.controller.claudeIsWaiting
      ? 'Claude is waiting: comment and Send to Claude (Cmd+Alt+Enter), or Approve and commit. Click to open the next file to do.'
      : 'Sift: click to open the next file to do';
    this.item.show();
  }
}
