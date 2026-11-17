import * as vscode from 'vscode';
import type { ChangeType, ReviewFile } from '../core/types';

const SCHEME = 'sift-change';

const DECORATIONS: Record<ChangeType, vscode.FileDecoration> = {
  added: new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
  modified: new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
  deleted: new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
};

/**
 * Resource URI for a file row in the Sift views. It keeps the file name (for the file icon) and
 * carries the change type, which the provider below turns into an A / M / D badge like Source Control.
 */
export function changeUri(file: ReviewFile): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${file.path}`, query: file.changeType });
}

export class ChangeDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) {
      return undefined;
    }
    return DECORATIONS[uri.query as ChangeType];
  }
}
