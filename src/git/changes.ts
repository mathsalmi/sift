import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GitRunner } from './GitRunner';
import type { ChangeType } from '../core/types';

export interface FileChange {
  path: string;
  changeType: ChangeType;
  adds: number | null;
  dels: number | null;
  binary: boolean;
}

const COUNT_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * Lists every file that differs between `base` and the working tree,
 * including untracked files. Renames are reported as delete + add (v1).
 */
export async function listChanges(git: GitRunner, base = 'HEAD'): Promise<FileChange[]> {
  const nameStatus = await git.run(['diff', '--name-status', '--no-renames', '-z', base]);
  const numstat = await git.run(['diff', '--numstat', '--no-renames', '-z', base]);
  const untracked = await git.run(['ls-files', '--others', '--exclude-standard', '-z']);

  const counts = parseNumstat(numstat);
  const changes = new Map<string, FileChange>();

  for (const entry of parseNameStatus(nameStatus)) {
    const count = counts.get(entry.path);
    changes.set(entry.path, {
      path: entry.path,
      changeType: entry.changeType,
      adds: count?.adds ?? null,
      dels: count?.dels ?? null,
      binary: count?.binary ?? false,
    });
  }

  for (const filePath of splitNul(untracked)) {
    const lines = await countUntracked(path.join(git.cwd, filePath));
    changes.set(filePath, {
      path: filePath,
      changeType: 'added',
      adds: lines.adds,
      dels: 0,
      binary: lines.binary,
    });
  }

  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function currentHead(git: GitRunner): Promise<string> {
  const result = await git.exec(['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] });
  if (result.exitCode !== 0) {
    throw new Error('This repository has no commits yet. Make an initial commit before starting a review.');
  }
  return result.stdout.trim();
}

/** Commits reachable from `head` but not from `base`, oldest first, with the files they touch. Empty when `base` is unknown. */
export async function commitsBetween(
  git: GitRunner,
  base: string,
  head: string,
): Promise<Array<{ sha: string; subject: string; files: string[] }>> {
  const result = await git.exec(['log', '--reverse', '--no-renames', '--name-only', '--format=%x1e%H%x1f%s', `${base}..${head}`], {
    okCodes: [0, 128],
  });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split('\x1e')
    .filter((chunk) => chunk.includes('\x1f'))
    .map((chunk) => {
      const [header, ...files] = chunk.split('\n');
      const [sha, subject] = header.split('\x1f');
      return { sha, subject, files: files.map((f) => f.trim()).filter(Boolean) };
    });
}

export async function hasStagedChanges(git: GitRunner): Promise<boolean> {
  const result = await git.exec(['diff', '--cached', '--quiet'], { okCodes: [0, 1] });
  return result.exitCode === 1;
}

/** Returns a description of an in-progress git operation, or null when the repo is idle. */
export async function operationInProgress(git: GitRunner): Promise<string | null> {
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const markers: Array<[string, string]> = [
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ];
  for (const [marker, label] of markers) {
    if (await exists(path.join(gitDir, marker))) {
      return label;
    }
  }
  return null;
}

/**
 * Stages exactly the given paths (including deletions) and commits them
 * with the user's own git identity and hooks. Returns the new HEAD sha.
 */
export async function commitPaths(git: GitRunner, paths: string[], message: string): Promise<string> {
  if (paths.length === 0) {
    throw new Error('Nothing to commit: the commit has no files.');
  }
  if (await hasStagedChanges(git)) {
    throw new Error('The index already has staged changes. Unstage them before approving a commit.');
  }

  await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') + '\0' });
  await git.run(['commit', '-m', message]);
  return currentHead(git);
}

interface NameStatusEntry {
  path: string;
  changeType: ChangeType;
}

function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = splitNul(output);
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    entries.push({ path: tokens[i + 1], changeType: toChangeType(tokens[i]) });
  }
  return entries;
}

function toChangeType(status: string): ChangeType {
  if (status.startsWith('A')) {
    return 'added';
  }
  if (status.startsWith('D')) {
    return 'deleted';
  }
  return 'modified';
}

interface LineCount {
  adds: number | null;
  dels: number | null;
  binary: boolean;
}

function parseNumstat(output: string): Map<string, LineCount> {
  const counts = new Map<string, LineCount>();
  for (const record of splitNul(output)) {
    const [adds, dels, ...rest] = record.split('\t');
    const filePath = rest.join('\t');
    if (!filePath) {
      continue;
    }
    if (adds === '-') {
      counts.set(filePath, { adds: null, dels: null, binary: true });
      continue;
    }
    counts.set(filePath, { adds: Number(adds), dels: Number(dels), binary: false });
  }
  return counts;
}

async function countUntracked(absolutePath: string): Promise<{ adds: number | null; binary: boolean }> {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size > COUNT_LIMIT_BYTES) {
    return { adds: null, binary: false };
  }
  const content = await fs.readFile(absolutePath);
  if (content.subarray(0, 8000).includes(0)) {
    return { adds: null, binary: true };
  }
  if (content.length === 0) {
    return { adds: 0, binary: false };
  }
  let lines = 0;
  for (const byte of content) {
    if (byte === 10) {
      lines++;
    }
  }
  if (content[content.length - 1] !== 10) {
    lines++;
  }
  return { adds: lines, binary: false };
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((token) => token.length > 0);
}

async function exists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(
    () => true,
    () => false,
  );
}

/** Unified diff of one file against HEAD; untracked files come back as all-added. */
export async function fileDiff(git: GitRunner, filePath: string, maxBytes = 200_000): Promise<string> {
  const tracked = await git.run(['diff', '--no-color', '--no-renames', 'HEAD', '--', filePath]);
  if (tracked.trim()) {
    return tracked;
  }
  const content = await fs.readFile(path.join(git.cwd, filePath)).catch(() => null);
  if (!content || content.includes(0)) {
    return '';
  }
  const lines = content.subarray(0, maxBytes).toString('utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return [`--- /dev/null`, `+++ b/${filePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
}
