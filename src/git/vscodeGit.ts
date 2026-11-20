import * as vscode from 'vscode';

/** The part of VS Code's Git extension API Sift uses (see the vscode.git extension's git.d.ts). */
export interface GitApiRepository {
  readonly rootUri: vscode.Uri;
  fetch(): Promise<void>;
  pull(): Promise<void>;
}

interface GitApi {
  getRepository(uri: vscode.Uri): GitApiRepository | null;
}

/**
 * The repository as VS Code's Git sees it, for network operations (fetch, pull): those go through
 * VS Code's Git so they get its sign-in and credential handling. Undefined when the Git extension
 * is off or doesn't know the repository.
 */
export async function gitRepository(root: string): Promise<GitApiRepository | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!extension) {
    return undefined;
  }
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const repository = exports.getAPI(1).getRepository(vscode.Uri.file(root));
    return repository ? wrap(repository) : undefined;
  } catch {
    return undefined;
  }
}

/** Errors of the Git API carry git's own message in stderr; surface that. */
function wrap(repository: GitApiRepository): GitApiRepository {
  const explain = (error: unknown): never => {
    const { stderr, message } = error as { stderr?: string; message?: string };
    throw new Error((stderr?.trim() || message || 'git failed').split('\n').slice(0, 3).join(' '));
  };
  return {
    rootUri: repository.rootUri,
    fetch: () => repository.fetch().catch(explain),
    pull: () => repository.pull().catch(explain),
  };
}
