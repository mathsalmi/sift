import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';

export interface AiStatus {
  busy(): number;
  label(): string;
}

/** "Review · Commit 3/14 · v2 · 212/500 approved · this round · AI working" */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly controller: ReviewController,
    private readonly ai: AiStatus,
  ) {
    this.item.command = 'sift.nextTodo';
    this.subscription = controller.onDidChange(() => this.render());
    this.render();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  render(): void {
    const model = this.controller.review;
    const busy = this.ai.busy();
    if (!model) {
      if (busy > 0) {
        this.item.text = '$(sync~spin) Sift: AI is planning';
        this.item.tooltip = this.ai.label();
        this.item.show();
      } else {
        this.item.hide();
      }
      return;
    }
    const p = model.progress();
    const parts = ['$(checklist) Review'];
    if (model.state.session.status === 'done') {
      parts.push('done');
    } else if (p.currentIndex !== null) {
      parts.push(`Commit ${p.currentIndex + 1}/${p.commitCount}`);
    } else {
      parts.push(`${p.committedCommits}/${p.commitCount} committed`);
    }
    parts.push(`${p.doneFiles}/${p.totalFiles} approved`);
    parts.push(this.controller.diffMode === 'round' ? 'this round' : 'cumulative');
    if (busy > 0) {
      parts.push('$(sync~spin) AI working');
    }
    this.item.text = parts.join(' · ');
    this.item.tooltip = `Sift: click to open the next file to do.\nAI: ${this.ai.label()}`;
    this.item.show();
  }
}
