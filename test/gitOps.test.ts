import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../src/git/GitRunner';
import { amendInto, branchStatus, commitEntries, discardEntries, listChanges } from '../src/git/changes';
import { applyHunks, fileHunks, headText, hunkTouches, parseHunks } from '../src/git/hunks';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;
let git: GitRunner;
const lines = (n: number, change: (i: number) => string | null = () => null) =>
  Array.from({ length: n }, (_, i) => change(i + 1) ?? `line ${i + 1}`).join('\n') + '\n';

beforeEach(() => {
  repo = createRepo({ 'a.txt': lines(30), 'b.txt': 'b\n' });
  git = new GitRunner(repo.dir);
});

afterEach(() => repo.cleanup());

describe('hunks', () => {
  it('splits a file into blocks of changes that rebuild it, alone or together', async () => {
    repo.write('a.txt', lines(31, (i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : i === 31 ? 'new last' : null)));
    const hunks = await fileHunks(git, 'a.txt');
    expect(hunks.map((h) => [h.newStart, h.newLines])).toEqual([
      [2, 1],
      [20, 1],
      [31, 1],
    ]);
    const base = (await headText(git, 'a.txt'))!;
    expect(applyHunks(base, hunks)).toBe(readFileSync(path.join(repo.dir, 'a.txt'), 'utf8'));
    expect(applyHunks(base, [hunks[1]])).toBe(lines(30, (i) => (i === 20 ? 'twenty' : null)));
    expect(hunkTouches(hunks[1], 18, 20)).toBe(true);
    expect(hunkTouches(hunks[1], 21, 25)).toBe(false);
  });

  it('keeps a missing newline at the end of the file', () => {
    const diff = ['@@ -2 +2 @@', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'].join('\n');
    const [hunk] = parseHunks(diff);
    expect(applyHunks('a\nb', [hunk])).toBe('a\nc');
  });

  it('keys identical changes apart and keeps a key while other changes move', () => {
    const one = parseHunks('@@ -1 +1 @@\n-x\n+y\n@@ -5 +5 @@\n-x\n+y\n');
    expect(one[0].key).not.toBe(one[1].key);
    const moved = parseHunks('@@ -1,0 +2 @@\n+new\n@@ -5 +6 @@\n-x\n+y\n');
    expect(moved[1].key).toBe(one[0].key);
  });
});

describe('commitEntries / discardEntries', () => {
  it('commits part of a file and leaves the rest in the working tree', async () => {
    repo.write('a.txt', lines(30, (i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : null)));
    const hunks = await fileHunks(git, 'a.txt');
    const content = applyHunks((await headText(git, 'a.txt'))!, [hunks[0]]);

    await commitEntries(git, [{ path: 'a.txt', content }], 'two');

    expect(repo.git('show', 'HEAD:a.txt')).toBe(lines(30, (i) => (i === 2 ? 'two' : null)));
    expect((await fileHunks(git, 'a.txt')).map((h) => h.key)).toEqual([hunks[1].key]);
  });

  it('discards whole files, new files and parts of files', async () => {
    repo.write('a.txt', lines(30, (i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : null)));
    repo.write('b.txt', 'changed\n');
    repo.write('new.txt', 'new\n');
    const hunks = await fileHunks(git, 'a.txt');
    const withoutFirst = applyHunks((await headText(git, 'a.txt'))!, [hunks[1]]);

    await discardEntries(git, [
      { path: 'a.txt', changeType: 'modified', content: withoutFirst },
      { path: 'b.txt', changeType: 'modified' },
      { path: 'new.txt', changeType: 'added' },
    ]);

    expect((await listChanges(git)).map((c) => c.path)).toEqual(['a.txt']);
    expect((await fileHunks(git, 'a.txt')).map((h) => h.key)).toEqual([hunks[1].key]);
    expect(existsSync(path.join(repo.dir, 'new.txt'))).toBe(false);
  });
});

describe('amendInto', () => {
  it('amends the last commit', async () => {
    repo.write('b.txt', 'b2\n');
    const first = await commitEntries(git, [{ path: 'b.txt' }], 'b2');
    repo.write('c.txt', 'c\n');

    const rewritten = await amendInto(git, first, [{ path: 'c.txt' }]);

    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(rewritten).toEqual(new Map([[first, head]]));
    expect(repo.git('show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['b2', '', 'b.txt', 'c.txt']);
  });

  it('folds a change into an older commit, rewriting the ones after it and keeping other changes', async () => {
    repo.write('b.txt', 'b2\n');
    const older = await commitEntries(git, [{ path: 'b.txt' }], 'b2');
    repo.write('a.txt', lines(30, (i) => (i === 1 ? 'one' : null)));
    const newer = await commitEntries(git, [{ path: 'a.txt' }], 'a1');
    repo.write('c.txt', 'c\n');
    repo.write('a.txt', lines(30, (i) => (i === 1 ? 'one' : i === 30 ? 'thirty' : null)));

    const rewritten = await amendInto(git, older, [{ path: 'c.txt' }]);

    const log = repo.git('log', '--format=%H %s', '-2').trim().split('\n');
    expect(log.map((l) => l.split(' ')[1])).toEqual(['a1', 'b2']);
    expect(rewritten.get(older)).toBe(log[1].split(' ')[0]);
    expect(rewritten.get(newer)).toBe(log[0].split(' ')[0]);
    expect(repo.git('show', '--name-only', '--format=', log[1].split(' ')[0]).trim().split('\n')).toEqual(['b.txt', 'c.txt']);
    // The other uncommitted change is still there.
    expect((await listChanges(git)).map((c) => c.path)).toEqual(['a.txt']);
  });

  it('changes nothing when the change conflicts with a later commit', async () => {
    repo.write('b.txt', 'b2\n');
    const older = await commitEntries(git, [{ path: 'b.txt' }], 'b2');
    repo.write('b.txt', 'b3\n');
    await commitEntries(git, [{ path: 'b.txt' }], 'b3');
    const head = repo.git('rev-parse', 'HEAD').trim();
    repo.write('b.txt', 'b4\n');

    await expect(amendInto(git, older, [{ path: 'b.txt' }])).rejects.toThrow(/conflicts/);

    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(readFileSync(path.join(repo.dir, 'b.txt'), 'utf8')).toBe('b4\n');
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('');
  });
});

describe('branchStatus', () => {
  it('reads the branch, its upstream and how far apart they are', async () => {
    expect(await branchStatus(git)).toEqual({ branch: 'main', upstream: null, ahead: 0, behind: 0 });
    const remote = createRepo();
    try {
      repo.git('remote', 'add', 'origin', remote.dir);
      repo.git('fetch', '-q', 'origin');
      repo.git('branch', '-q', '--set-upstream-to=origin/main');
      expect(await branchStatus(git)).toMatchObject({ branch: 'main', upstream: 'origin/main' });
      const status = await branchStatus(git);
      expect(status.ahead).toBeGreaterThan(0);
      expect(status.behind).toBeGreaterThan(0);
    } finally {
      remote.cleanup();
    }
  });
});
