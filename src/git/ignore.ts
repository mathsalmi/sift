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

/**
 * Appends a pattern per path, and one per folder (`dirs`, with a trailing slash), to the ignore file,
 * skipping ones already there. Returns the file.
 */
export async function ignorePaths(git: GitRunner, paths: string[], target: IgnoreTarget, dirs: string[] = []): Promise<string> {
  const file = await ignoreFile(git, target);
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const patterns = [...dirs.map((d) => `${ignorePattern(d.replace(/\/+$/, ''))}/`), ...paths.map(ignorePattern)];
  const added = [...new Set(patterns)].filter((pattern) => !existing.has(pattern));
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

/** Sift's own entry, which keeps its state out of commits. It is never listed or removed. */
const STATE_ENTRY = '.sift/';

/** A rule in .git/info/exclude: the line as written, and what to show for it. */
export interface ExcludeEntry {
  pattern: string;
  /** The repo-relative path for rules that name one file (as Sift writes them), else the pattern. */
  label: string;
  /** Set when the rule names exactly one file. */
  path?: string;
}

/** The rules in .git/info/exclude, without comments, blank lines and Sift's own entry. */
export async function excludedEntries(git: GitRunner): Promise<ExcludeEntry[]> {
  const file = await ignoreFile(git, 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const seen = new Set<string>();
  const entries: ExcludeEntry[] = [];
  for (const raw of current.split(/\r?\n/)) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('#') || pattern === STATE_ENTRY || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    const path = patternPath(pattern);
    const folder = pattern.endsWith('/') ? patternPath(pattern.slice(0, -1)) : undefined;
    entries.push({ pattern, label: path ?? (folder !== undefined ? `${folder}/` : pattern), path });
  }
  return entries;
}

/** Removes these rules from .git/info/exclude, so their files show up again. */
export async function unexcludePatterns(git: GitRunner, patterns: string[]): Promise<void> {
  const file = await ignoreFile(git, 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const drop = new Set(patterns.filter((p) => p !== STATE_ENTRY));
  const kept = current.split(/\r?\n/).filter((line) => !drop.has(line.trim()));
  if (kept.length !== current.split(/\r?\n/).length) {
    await fs.writeFile(file, kept.join('\n'), 'utf8');
  }
}

/** The file an anchored, wildcard-free rule names (the reverse of ignorePattern), else undefined. */
function patternPath(pattern: string): string | undefined {
  if (!pattern.startsWith('/') || pattern.endsWith('/') || pattern.startsWith('!')) {
    return undefined;
  }
  let result = '';
  const body = pattern.slice(1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) {
      result += body[++i];
      continue;
    }
    if (c === '*' || c === '?' || c === '[') {
      return undefined;
    }
    result += c;
  }
  return result;
}
