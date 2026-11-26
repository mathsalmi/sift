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

/** What to stage for a file: all of it, or only `content` (part of its changes, see git/hunks.ts). */
export interface StageEntry {
  path: string;
  content?: string;
}

/**
 * Stages the entries in the index `env` points to: whole files as they are in the working tree
 * (including deletions), parts of files as the given content.
 */
async function stageEntries(git: GitRunner, entries: StageEntry[], env: NodeJS.ProcessEnv): Promise<void> {
  const whole = entries.filter((e) => e.content === undefined).map((e) => e.path);
  if (whole.length > 0) {
    await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: whole.join('\0') + '\0', env });
  }
  for (const entry of entries.filter((e) => e.content !== undefined)) {
    const sha = (await git.run(['hash-object', '-w', '--stdin', '--no-filters'], { input: entry.content })).trim();
    const mode = (await git.run(['ls-tree', 'HEAD', '--', `:(literal)${entry.path}`])).split(' ')[0] || '100644';
    await git.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${entry.path}`], { env });
  }
}

/**
 * Runs a commit command on exactly the entries: they are staged in a private index (HEAD plus the
 * entries), so whatever the user staged in the real index stays out of the commit and stays staged.
 * Afterwards the real index takes the committed paths as HEAD now has them.
 */
async function commitWith(git: GitRunner, entries: StageEntry[], args: string[]): Promise<void> {
  if (entries.length === 0) {
    throw new Error('Nothing to commit: the commit has no files.');
  }
  const indexFile = path.resolve(git.cwd, (await git.run(['rev-parse', '--git-path', 'sift/commit-index'])).trim());
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git.run(['read-tree', 'HEAD'], { env });
    await stageEntries(git, entries, env);
    await git.run(args, { env });
  } finally {
    await fs.rm(indexFile, { force: true });
  }
  await syncIndex(git, entries.map((e) => e.path));
}

/** Sets the real index entries of these paths to HEAD's. */
async function syncIndex(git: GitRunner, paths: string[]): Promise<void> {
  await git.run(['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') + '\0' });
}

/**
 * Commits exactly the given entries with the user's own git identity and hooks, leaving anything
 * else the user staged staged. Returns the new HEAD sha.
 */
export async function commitEntries(git: GitRunner, entries: StageEntry[], message: string): Promise<string> {
  await commitWith(git, entries, ['commit', '-m', message]);
  return currentHead(git);
}

/** Stages exactly the given paths (including deletions) and commits them. Returns the new HEAD sha. */
export async function commitPaths(git: GitRunner, paths: string[], message: string): Promise<string> {
  return commitEntries(
    git,
    paths.map((p) => ({ path: p })),
    message,
  );
}

/**
 * Throws away uncommitted changes: files go back to HEAD, new files are deleted, and parts of files
 * get `content` (the file without the discarded changes).
 */
export async function discardEntries(
  git: GitRunner,
  entries: Array<{ path: string; changeType: ChangeType; content?: string }>,
): Promise<void> {
  // A new folder in the list is another repository (git lists those as "folder/"): never delete one.
  for (const entry of entries.filter((e) => e.changeType === 'added' && e.content === undefined)) {
    const stat = await fs.lstat(path.join(git.cwd, ...entry.path.split('/'))).catch(() => null);
    if (stat?.isDirectory()) {
      throw new Error(`${entry.path.replace(/\/$/, '')} is a folder with its own git repository. Sift won't delete it; remove it yourself if you mean to.`);
    }
  }
  for (const entry of entries) {
    const full = path.join(git.cwd, ...entry.path.split('/'));
    if (entry.content !== undefined) {
      await fs.writeFile(full, entry.content, 'utf8');
    } else if (entry.changeType === 'added') {
      await git.exec(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', `:(literal)${entry.path}`], { okCodes: [0, 128] });
      await fs.rm(full, { force: true });
    } else {
      await git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${entry.path}`]);
    }
  }
}

/**
 * Folds the entries into `target`, a commit in HEAD's history that wasn't pushed: amends HEAD, or
 * for an older commit makes a fixup commit and squashes it in with a rebase (keeping other
 * uncommitted changes aside meanwhile; what was staged comes back unstaged). Returns old sha → new
 * sha for every commit it rewrote.
 * On a conflict nothing changes and it throws.
 */
export async function amendInto(git: GitRunner, target: string, entries: StageEntry[]): Promise<Map<string, string>> {
  const head = await currentHead(git);
  if (target !== head) {
    const parent = await git.exec(['rev-parse', '--verify', '--quiet', `${target}~1`], { okCodes: [0, 1, 128] });
    if (parent.exitCode !== 0) {
      throw new Error("The repository's first commit can only be amended while it is the last one.");
    }
    if ((await git.run(['rev-list', '--merges', `${target}..${head}`])).trim()) {
      throw new Error('There are merge commits after it, so Sift won\'t rewrite that history. Amend into a later commit instead.');
    }
  }
  const before = target === head ? [head] : await ancestry(git, target, head);
  await commitWith(git, entries, target === head ? ['commit', '--amend', '--no-edit'] : ['commit', '--no-verify', `--fixup=${target}`]);
  if (target !== head) {
    const parent = `${target}~1`;
    const rebase = await git.exec(['rebase', '-i', '--autosquash', '--autostash', '--quiet', parent], {
      okCodes: [0, 1, 128],
      env: { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
    });
    if (rebase.exitCode !== 0) {
      await git.exec(['rebase', '--abort'], { okCodes: [0, 1, 128] });
      // Back to before: drop the fixup commit (its changes are still in the working tree) and put
      // those paths back in the index as they were, leaving what the user staged alone.
      await git.run(['reset', '-q', '--soft', head]);
      await syncIndex(git, entries.map((e) => e.path));
      throw new Error(
        'The change conflicts with commits made after the target, so nothing was amended. Amend it into a later commit instead.',
      );
    }
  }
  const after = target === head ? [await currentHead(git)] : await ancestry(git, target, 'HEAD');
  const rewritten = new Map<string, string>();
  before.forEach((sha, i) => {
    if (after[i] && after[i] !== sha) {
      rewritten.set(sha, after[i]);
    }
  });
  return rewritten;
}

/** `from` and the commits after it up to `to`, oldest first. */
async function ancestry(git: GitRunner, from: string, to: string): Promise<string[]> {
  const out = await git.run(['rev-list', '--reverse', '--first-parent', `${from}~1..${to}`]);
  return out.split('\n').filter(Boolean);
}

/** The branch HEAD is on, its upstream, and how far apart they are (from the last fetch). */
export interface BranchStatus {
  /** null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export async function branchStatus(git: GitRunner): Promise<BranchStatus> {
  const name = (await git.exec(['symbolic-ref', '--quiet', '--short', 'HEAD'], { okCodes: [0, 1, 128] })).stdout.trim();
  const branch = name || null;
  const upstreamResult = await git.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    okCodes: [0, 128],
  });
  const upstream = branch && upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() || null : null;
  if (!upstream) {
    return { branch, upstream: null, ahead: 0, behind: 0 };
  }
  const counts = await git.exec(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { okCodes: [0, 128] });
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  return { branch, upstream, ahead: ahead || 0, behind: behind || 0 };
}

/** The files a commit changed compared with its first parent (or with nothing, for a root commit). */
export async function commitChanges(git: GitRunner, sha: string): Promise<FileChange[]> {
  const base = ['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '-z'];
  const nameStatus = await git.run([...base, '--name-status', sha]);
  const counts = parseNumstat(await git.run([...base, '--numstat', sha]));
  return parseNameStatus(nameStatus).map((entry) => {
    const count = counts.get(entry.path);
    return {
      path: entry.path,
      changeType: entry.changeType,
      adds: count?.adds ?? null,
      dels: count?.dels ?? null,
      binary: count?.binary ?? false,
    };
  });
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
