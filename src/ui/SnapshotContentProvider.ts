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

/**
 * Query of the other side of a diff of a part of a split file: the file without the part's own
 * changes. `version` changes with the file's changes, so an open diff never shows a stale side.
 */
export function partQuery(commitId: string | null, version: string): string {
  return `part:${commitId ?? '-'}:${version}`;
}

export function parsePartQuery(query: string): { commitId: string | null } | null {
  const match = /^part:([^:]+):/.exec(query);
  return match ? { commitId: match[1] === '-' ? null : match[1] } : null;
}

/** Serves read-only file content from snapshots so they open in the native diff editor. */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly snapshots: SnapshotService,
    /** A file without the changes its part in a commit holds (see partQuery). */
    private readonly partBase: (filePath: string, commitId: string | null) => Promise<string>,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const treeish = uri.query;
    if (!treeish || treeish === 'empty') {
      return '';
    }
    const filePath = uri.path.replace(/^\//, '');
    const part = parsePartQuery(treeish);
    if (part) {
      return this.partBase(filePath, part.commitId);
    }
    return (await this.snapshots.show(treeish, filePath)) ?? '';
  }
}
