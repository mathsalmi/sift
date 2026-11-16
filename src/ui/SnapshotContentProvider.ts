import * as vscode from 'vscode';
import type { SnapshotService } from '../git/SnapshotService';

export const SCHEME = 'sift';

/**
 * URI for a file at a tree-ish: sift:/<path>?<treeish>.
 * The tree-ish is a snapshot tree sha, "HEAD", or "empty" for a blank side.
 */
export function snapshotUri(treeish: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${filePath}`, query: treeish });
}

/** Serves read-only file content from snapshots so they open in the native diff editor. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly snapshots: SnapshotService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const treeish = uri.query;
    if (!treeish || treeish === 'empty') {
      return '';
    }
    const filePath = uri.path.replace(/^\//, '');
    return (await this.snapshots.show(treeish, filePath)) ?? '';
  }
}
