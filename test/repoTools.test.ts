import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRepoTool } from '../src/ai/repoTools';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;

beforeEach(() => {
  repo = createRepo({ 'src/a.ts': 'export function alpha() {}\nalpha();\n', 'README.md': 'hi\n' });
  repo.write('src/new.ts', 'import { alpha } from "./a";\n');
  repo.write('.gitignore', 'dist/\n');
  repo.write('dist/out.js', 'alpha\n');
});

afterEach(() => repo.cleanup());

describe('runRepoTool', () => {
  it('reads files with line numbers, also a range', async () => {
    expect(await runRepoTool(repo.dir, 'read_file', { path: 'src/a.ts' })).toBe('src/a.ts (2 lines)\n1\texport function alpha() {}\n2\talpha();');
    expect(await runRepoTool(repo.dir, 'read_file', { path: 'src/a.ts', startLine: 2 })).toBe('src/a.ts (2 lines)\n2\talpha();');
  });

  it('searches tracked and new files, but not ignored ones', async () => {
    const out = await runRepoTool(repo.dir, 'search', { pattern: 'alpha' });
    expect(out.split('\n').sort()).toEqual(['src/a.ts:1:export function alpha() {}', 'src/a.ts:2:alpha();', 'src/new.ts:1:import { alpha } from "./a";']);
    expect(await runRepoTool(repo.dir, 'search', { pattern: 'nothing-here' })).toBe('No matches.');
  });

  it('lists files without ignored ones, optionally under a folder', async () => {
    expect((await runRepoTool(repo.dir, 'list_files', {})).split('\n').sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts', 'src/new.ts']);
    expect((await runRepoTool(repo.dir, 'list_files', { path: 'src' })).split('\n').sort()).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('stays inside the repository', async () => {
    expect(await runRepoTool(repo.dir, 'read_file', { path: '../outside.txt' })).toMatch(/outside the repository/);
    expect(await runRepoTool(repo.dir, 'read_file', { path: '.git/config' })).toMatch(/outside the repository/);
    expect(await runRepoTool(repo.dir, 'search', { pattern: 'x', path: '/etc' })).toMatch(/outside the repository/);
  });
});
