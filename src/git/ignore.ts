import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GitRunner } from './GitRunner';

export type IgnoreTarget = 'gitignore' | 'exclude';

/** A gitignore pattern that matches exactly this repo-relative file. */
export function ignorePattern(filePath: string): string {
  let pattern = filePath.replace(/[\\*?[\]]/g, (c) => `\\${c}`);
  // Trailing spaces are dropped by git unless escaped.
  pattern = pattern.replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
  // A leading "/" anchors it to the repo root, so it never matches a file of the same name elsewhere.
  return `/${pattern}`;
}

/** The ignore file a target writes to: the repo's root .gitignore, or the local .git/info/exclude. */
export async function ignoreFile(git: GitRunner, target: IgnoreTarget): Promise<string> {
  if (target === 'gitignore') {
    return path.join(git.cwd, '.gitignore');
  }
  // --git-path resolves to the common dir in worktrees, where info/exclude lives.
  const excludePath = (await git.run(['rev-parse', '--git-path', 'info/exclude'])).trim();
  return path.resolve(git.cwd, excludePath);
}

/** Appends a pattern per path to the ignore file, skipping ones already there. Returns the file. */
export async function ignorePaths(git: GitRunner, paths: string[], target: IgnoreTarget): Promise<string> {
  const file = await ignoreFile(git, target);
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const added = [...new Set(paths.map(ignorePattern))].filter((pattern) => !existing.has(pattern));
  if (added.length > 0) {
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${current}${separator}${added.join('\n')}\n`, 'utf8');
  }
  return file;
}

/** The paths git tracks (in HEAD or the index): ignoring them does not hide their changes. */
export async function trackedPaths(git: GitRunner, paths: string[]): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  const out = await git.run(['ls-files', '-z', '--', ...paths.map((p) => `:(literal)${p}`)]);
  const tracked = new Set(out.split('\0').filter(Boolean));
  // A file removed from the index (git rm) is still tracked while it is in HEAD.
  const inHead = await git.exec(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths], { okCodes: [0, 128] });
  for (const p of inHead.stdout.split('\0').filter(Boolean)) {
    tracked.add(p);
  }
  return paths.filter((p) => tracked.has(p));
}
