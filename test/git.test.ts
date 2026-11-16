import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../src/git/GitRunner';
import { commitPaths, currentHead, hasStagedChanges, listChanges } from '../src/git/changes';
import { SnapshotService, snapshotRef, sessionRefPrefix } from '../src/git/SnapshotService';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;
let git: GitRunner;

beforeEach(() => {
  repo = createRepo({ 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\n', 'docs/old.md': 'old\n' });
  git = new GitRunner(repo.dir);
});

afterEach(() => repo.cleanup());

describe('listChanges', () => {
  it('reports modified, added (untracked) and deleted files with line counts', async () => {
    repo.write('src/a.ts', 'a1\nA2\na3\n');
    repo.write('src/new.ts', 'n1\nn2\nn3');
    repo.remove('docs/old.md');

    const changes = await listChanges(git);

    expect(changes).toEqual([
      { path: 'docs/old.md', changeType: 'deleted', adds: 0, dels: 1, binary: false },
      { path: 'src/a.ts', changeType: 'modified', adds: 2, dels: 1, binary: false },
      { path: 'src/new.ts', changeType: 'added', adds: 3, dels: 0, binary: false },
    ]);
  });

  it('respects .gitignore for untracked files', async () => {
    repo.write('.gitignore', 'dist/\n');
    repo.write('dist/out.js', 'x\n');

    const changes = await listChanges(git);

    expect(changes.map((c) => c.path)).toEqual(['.gitignore']);
  });
});

describe('SnapshotService', () => {
  it('snapshots the working tree without touching the real index', async () => {
    const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
    repo.write('src/a.ts', 'changed\n');
    repo.write('src/new.ts', 'new\n');

    const tree = await snapshots.writeWorkingTree();
    const snap = await snapshots.store(tree, snapshotRef('s1', 'c_01', 0), 'v0');

    expect(await snapshots.show(snap.treeSha, 'src/a.ts')).toBe('changed\n');
    expect(await snapshots.show(snap.treeSha, 'src/new.ts')).toBe('new\n');
    expect(await snapshots.show('HEAD', 'src/a.ts')).toBe('a1\na2\n');
    expect(await hasStagedChanges(git)).toBe(false);
    expect(repo.git('status', '--porcelain')).toContain('?? src/new.ts');
  });

  it('returns null for a file absent at the tree-ish', async () => {
    const snapshots = await SnapshotService.create(git, 0);
    repo.remove('src/b.ts');
    const tree = await snapshots.writeWorkingTree();

    expect(await snapshots.show(tree, 'src/b.ts')).toBeNull();
    expect(await snapshots.show('HEAD', 'missing.ts')).toBeNull();
  });

  it('gives the same tree when nothing changed and lists paths changed between rounds', async () => {
    const snapshots = await SnapshotService.create(git, 0);
    repo.write('src/a.ts', 'round0\n');
    const v0 = await snapshots.writeWorkingTree();
    expect(await snapshots.writeWorkingTree()).toBe(v0);

    repo.write('src/b.ts', 'round1\n');
    const v1 = await snapshots.writeWorkingTree();

    expect(await snapshots.changedPaths(v0, v1)).toEqual(['src/b.ts']);
  });

  it('leaves large new files out of snapshots', async () => {
    const snapshots = await SnapshotService.create(git, 10);
    repo.write('big.bin', 'x'.repeat(100));
    repo.write('small.txt', 'ok\n');

    const tree = await snapshots.writeWorkingTree();

    expect(await snapshots.show(tree, 'big.bin')).toBeNull();
    expect(await snapshots.show(tree, 'small.txt')).toBe('ok\n');
  });

  it('deletes all refs of a session', async () => {
    const snapshots = await SnapshotService.create(git, 0);
    const tree = await snapshots.writeWorkingTree();
    await snapshots.store(tree, snapshotRef('s1', 'c_01', 0), 'v0');
    await snapshots.store(tree, snapshotRef('s1', 'c_02', 0), 'v0');

    expect(await snapshots.deleteRefs(sessionRefPrefix('s1'))).toBe(2);
    expect(repo.git('for-each-ref', 'refs/sift')).toBe('');
  });
});

describe('commitPaths', () => {
  it('commits only the given paths, including deletions and new files', async () => {
    repo.write('src/a.ts', 'changed\n');
    repo.write('src/new.ts', 'new\n');
    repo.remove('docs/old.md');

    const sha = await commitPaths(git, ['src/new.ts', 'docs/old.md'], 'Add new, drop old');

    expect(sha).toBe(await currentHead(git));
    expect(repo.git('show', '--name-status', '--format=%s', 'HEAD')).toBe('Add new, drop old\n\nD\tdocs/old.md\nA\tsrc/new.ts\n');
    expect(repo.git('status', '--porcelain')).toBe(' M src/a.ts\n');
  });

  it('refuses when the index already has staged changes', async () => {
    repo.write('src/a.ts', 'changed\n');
    repo.git('add', 'src/a.ts');

    await expect(commitPaths(git, ['src/a.ts'], 'msg')).rejects.toThrow(/already has staged changes/);
  });
});
