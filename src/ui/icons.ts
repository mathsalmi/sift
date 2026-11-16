import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewFile } from '../core/types';

export function fileIcon(file: ReviewFile): vscode.ThemeIcon {
  if (file.status === 'done') {
    return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
  }
  if (file.status === 'in-progress') {
    return new vscode.ThemeIcon('circle-large-filled', new vscode.ThemeColor('charts.yellow'));
  }
  return new vscode.ThemeIcon('circle-large-outline');
}

/** "src/ui · +12 -3 · changed in v2" */
export function fileDescription(file: ReviewFile, withDir: boolean): string {
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
  if (file.changeType !== 'modified') {
    parts.push(file.changeType);
  }
  if (file.changedInIteration !== undefined) {
    parts.push(`changed in v${file.changedInIteration}`);
  }
  return parts.join(' · ');
}
