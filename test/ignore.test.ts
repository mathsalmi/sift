import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../src/git/GitRunner';
import { listChanges } from '../src/git/changes';
import { ignorePaths, ignorePattern, trackedPaths } from '../src/git/ignore';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;
let git: GitRunner;

beforeEach(() => {
  repo = createRepo({ 'src/a.ts': 'a\n' });
  git = new GitRunner(repo.dir);
});

afterEach(() => repo.cleanup());

describe('ignorePattern', () => {
  it('anchors the path and escapes pattern characters', () => {
    expect(ignorePattern('src/a.ts')).toBe('/src/a.ts');
    expect(ignorePattern('a[1]*?.txt')).toBe('/a\\[1\\]\\*\\?.txt');
    expect(ignorePattern('#notes.md')).toBe('/#notes.md');
    expect(ignorePattern('trailing  ')).toBe('/trailing\\ \\ ');
  });
});

describe('ignorePaths', () => {
  it('adds untracked files to .gitignore once, so they leave the changes', async () => {
    repo.write('.gitignore', 'node_modules');
    repo.write('tmp/log.txt', 'x\n');
    repo.write('[weird].txt', 'x\n');

    await ignorePaths(git, ['tmp/log.txt', '[weird].txt'], 'gitignore');
    await ignorePaths(git, ['tmp/log.txt'], 'gitignore');

    expect(readFileSync(path.join(repo.dir, '.gitignore'), 'utf8')).toBe('node_modules\n/tmp/log.txt\n/\\[weird\\].txt\n');
    const changed = (await listChanges(git)).map((c) => c.path);
    expect(changed).toEqual(['.gitignore']);
  });

  it('excludes files locally through .git/info/exclude', async () => {
    repo.write('local.env', 'x\n');

    const file = await ignorePaths(git, ['local.env'], 'exclude');

    expect(file).toBe(path.join(repo.dir, '.git', 'info', 'exclude'));
    expect(readFileSync(file, 'utf8')).toContain('/local.env\n');
    expect(await listChanges(git)).toEqual([]);
  });
});

describe('trackedPaths', () => {
  it('finds files git tracks, including deleted ones', async () => {
    repo.write('src/a.ts', 'changed\n');
    repo.write('new.ts', 'x\n');
    expect(await trackedPaths(git, ['src/a.ts', 'new.ts'])).toEqual(['src/a.ts']);
    repo.git('rm', '-qf', 'src/a.ts');
    expect(await trackedPaths(git, ['src/a.ts'])).toEqual(['src/a.ts']);
  });
});
