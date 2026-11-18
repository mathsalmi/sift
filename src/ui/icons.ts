import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommitReviewStatus, ReviewFile } from '../core/types';

/**
 * File icons are plain indicators (file type, or an eye while in progress), never circles,
 * so they don't read as buttons. Approval is the checkbox in front of the file.
 */
export function fileIcon(file: ReviewFile): vscode.ThemeIcon {
  if (file.status === 'in-progress') {
    return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow'));
  }
  return vscode.ThemeIcon.File;
}

/** Checkbox state for a pending file: checked = approved. */
export function fileCheckbox(file: ReviewFile): vscode.TreeItem['checkboxState'] {
  const approved = file.status === 'done';
  return {
    state: approved ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
    tooltip: approved ? 'Approved. Click to unapprove.' : 'Click to approve this file.',
  };
}

export const COMMIT_STATUS_LABEL: Record<CommitReviewStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  approved: 'Approved',
  committed: 'Committed',
};

export function commitIcon(status: CommitReviewStatus): vscode.ThemeIcon {
  switch (status) {
    case 'committed':
      return new vscode.ThemeIcon('check-all', new vscode.ThemeColor('charts.green'));
    case 'approved':
      return new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.green'));
    case 'in-progress':
      return new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.yellow'));
    default:
      return new vscode.ThemeIcon('git-commit');
  }
}

/**
 * "src/ui · +12 -3 · changed in v2". `versionOf` turns a snapshot number into the file's own
 * version number (a file's version only goes up when the file changed).
 */
export function fileDescription(file: ReviewFile, withDir: boolean, versionOf: (n: number) => number): string {
  const parts: string[] = [];
  const dir = path.posix.dirname(file.path);
  if (withDir && dir !== '.') {
    parts.push(dir);
  }
  if (file.binary) {
    parts.push('binary');
  } else if (file.adds !== null || file.dels !== null) {
    parts.push(`+${file.adds ?? '?'} -${file.dels ?? '?'}`);
  }
  if (file.changedSinceApproval) {
    parts.push('changed since approval');
  } else if (file.changedInIteration !== undefined) {
    parts.push(`changed in v${versionOf(file.changedInIteration)}`);
  }
  return parts.join(' · ');
}
