import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitError, type GitRunner } from './GitRunner';
import { REF_ROOT } from './SnapshotService';

/** Content id of a deleted file, for approvals of deletions. */
export const DELETED_BLOB = 'deleted';

/**
 * The private ref that records which git commit a planned commit became. Lives next to the
 * session's snapshot refs, so "Discard plan" removes it with them. Nothing touches the commit message.
 */
export function commitRef(sessionId: string, commitId: string, kind: CommitRefKind = 'commit'): string {
  return `${REF_ROOT}/${sessionId}/${commitId}/${kind}`;
}

/** commit: the git commit a planned commit became; revert: the git commit that reverted it. */
export type CommitRefKind = 'commit' | 'revert';

/** Planned commit id → the git commit its ref (of this kind) points to. */
export async function readCommitRefs(git: GitRunner, sessionId: string, kind: CommitRefKind = 'commit'): Promise<Map<string, string>> {
  const prefix = `${REF_ROOT}/${sessionId}/`;
  const out = await git.run(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, sha] = line.trim().split(' ');
    const match = name ? new RegExp(`^(.*)/${kind}$`).exec(name.slice(prefix.length)) : null;
    if (match && sha) {
      refs.set(match[1], sha);
    }
  }
  return refs;
}

export async function setCommitRef(
  git: GitRunner,
  sessionId: string,
  commitId: string,
  sha: string | null,
  kind: CommitRefKind = 'commit',
): Promise<void> {
  const ref = commitRef(sessionId, commitId, kind);
  if (sha) {
    await git.run(['update-ref', ref, sha]);
  } else {
    await git.exec(['update-ref', '-d', ref], { okCodes: [0, 1] });
  }
}

/** Whether `sha` is in HEAD's history. */
export async function inHeadHistory(git: GitRunner, sha: string): Promise<boolean> {
  const result = await git.exec(['merge-base', '--is-ancestor', sha, 'HEAD'], { okCodes: [0, 1, 128] });
  return result.exitCode === 0;
}

/** Whether a remote-tracking branch has the commit (it was pushed, so undoing it would rewrite shared history). */
export async function isPushed(git: GitRunner, sha: string): Promise<boolean> {
  const result = await git.exec(['rev-list', '-n', '1', sha, '--not', '--remotes'], { okCodes: [0, 128] });
  return result.exitCode === 0 && result.stdout.trim() === '';
}

/** Subjects of the commits made on top of `sha` in HEAD's history, newest first. */
export async function commitsAfter(git: GitRunner, sha: string): Promise<Array<{ sha: string; subject: string }>> {
  const out = await git.run(['log', '--format=%H %s', `${sha}..HEAD`]);
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => ({ sha: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }));
}

/**
 * Undoes `sha` and every commit after it: HEAD moves to its parent, and their changes go back to the
 * working tree as uncommitted changes (nothing is lost, the index is left empty).
 */
export async function undoCommits(git: GitRunner, sha: string): Promise<void> {
  await git.run(['reset', '--mixed', '--quiet', `${sha}~1`]);
}

/** Makes a new commit that undoes `sha`. Returns it. On a conflict, leaves git mid-revert and throws. */
export async function revertCommit(git: GitRunner, sha: string): Promise<string> {
  try {
    await git.run(['revert', '--no-edit', sha]);
  } catch (error) {
    const detail = error instanceof GitError ? error.stderr.trim().split('\n')[0] : (error as Error).message;
    throw new Error(
      `git could not revert ${sha.slice(0, 7)}: ${detail} Resolve it and run "git revert --continue", or "git revert --abort".`,
    );
  }
  return (await git.run(['rev-parse', 'HEAD'])).trim();
}

/**
 * For each path, the newest commit since `base` that touched it, with its age (0 = newest).
 * Paths no commit touched are left out; an unknown `base` gives an empty map.
 */
export async function lastTouches(git: GitRunner, base: string, paths: string[]): Promise<Map<string, { sha: string; age: number }>> {
  const touches = new Map<string, { sha: string; age: number }>();
  if (paths.length === 0) {
    return touches;
  }
  const result = await git.exec(
    ['log', '--no-renames', '--name-only', '-z', '--format=%x1e%H', `${base}..HEAD`, '--', ...paths.map((p) => `:(literal)${p}`)],
    { okCodes: [0, 128] },
  );
  if (result.exitCode !== 0) {
    return touches;
  }
  const wanted = new Set(paths);
  let age = 0;
  for (const chunk of result.stdout.split('\x1e').filter((c) => c.trim())) {
    const [sha, ...rest] = chunk.split(/[\n\0]/).map((t) => t.trim());
    for (const filePath of rest) {
      if (filePath && wanted.has(filePath) && !touches.has(filePath)) {
        touches.set(filePath, { sha, age });
      }
    }
    age++;
  }
  return touches;
}

/** Git's content id of each file as it is now on disk; DELETED_BLOB when the file is gone. */
export async function blobHashes(git: GitRunner, paths: string[], write = false): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const present: string[] = [];
  for (const filePath of new Set(paths)) {
    const stat = await fs.stat(path.join(git.cwd, filePath)).catch(() => null);
    if (stat?.isFile()) {
      present.push(filePath);
    } else {
      hashes.set(filePath, DELETED_BLOB);
    }
  }
  if (present.length > 0) {
    const out = await git.run(['hash-object', ...(write ? ['-w'] : []), '--stdin-paths'], { input: present.join('\n') + '\n' });
    out
      .trim()
      .split('\n')
      .forEach((sha, i) => hashes.set(present[i], sha.trim()));
  }
  return hashes;
}

/**
 * Keeps approved content in git, so "changed since approval" can diff against it later. A ref per
 * blob stops gc from pruning it; the refs sit under the session and go away with "Discard plan".
 */
export async function keepBlobs(git: GitRunner, sessionId: string, blobs: Iterable<string>): Promise<void> {
  const lines = [...new Set(blobs)]
    .filter((sha) => sha !== DELETED_BLOB)
    .map((sha) => `update ${REF_ROOT}/${sessionId}/approved/${sha} ${sha}\n`);
  if (lines.length > 0) {
    await git.run(['update-ref', '--stdin'], { input: lines.join('') });
  }
}

/** Whether git has this blob (approvals saved before approved content was kept may not). */
export async function hasBlob(git: GitRunner, sha: string): Promise<boolean> {
  const result = await git.exec(['cat-file', '-e', `${sha}^{blob}`], { okCodes: [0, 1, 128] });
  return result.exitCode === 0;
}
