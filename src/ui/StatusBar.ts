import * as vscode from 'vscode';
import type { ReviewController } from '../controller/ReviewController';

export interface AiStatus {
  busy(): number;
  label(): string;
  /** A few words for the status bar, e.g. "Claude Code (opus)". */
  shortLabel(): string;
}

/**
 * "Review · Commit 3/14 · 212/500 approved · AI working", and next to it the AI in
 * use ("Claude Code"), which opens the AI picker.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly aiItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly subscription: vscode.Disposable;
  private readonly configSubscription: vscode.Disposable;

  constructor(
    private readonly controller: ReviewController,
    private readonly ai: AiStatus,
  ) {
    this.item.command = 'sift.nextTodo';
    this.aiItem.command = 'sift.chooseAi';
    this.subscription = controller.onDidChange(() => this.render());
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sift.ai')) {
        this.render();
      }
    });
    this.render();
  }

  dispose(): void {
    this.subscription.dispose();
    this.configSubscription.dispose();
    this.item.dispose();
    this.aiItem.dispose();
  }

  render(): void {
    const model = this.controller.review;
    const busy = this.ai.busy();
    this.aiItem.text = `$(hubot) ${this.ai.shortLabel()}`;
    this.aiItem.tooltip = `Sift asks ${this.ai.label()}. Click to choose another AI.`;
    if (model || busy > 0) {
      this.aiItem.show();
    } else {
      this.aiItem.hide();
    }
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
    if (busy > 0) {
      parts.push('$(sync~spin) AI working');
    }
    this.item.text = parts.join(' · ');
    this.item.tooltip = 'Sift: click to open the next file to do.';
    this.item.show();
  }
}
