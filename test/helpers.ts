import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface TempRepo {
  dir: string;
  write(file: string, content: string): void;
  remove(file: string): void;
  git(...args: string[]): string;
  cleanup(): void;
}

/** A throwaway git repo with one initial commit. */
export function createRepo(initialFiles: Record<string, string> = { 'README.md': 'hello\n' }): TempRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'sift-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  // Windows runners default to core.autocrlf=true; keep files byte for byte as written.
  git('config', 'core.autocrlf', 'false');

  const repo: TempRepo = {
    dir,
    write(file, content) {
      const full = path.join(dir, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    remove(file) {
      rmSync(path.join(dir, file));
    },
    git,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };

  for (const [file, content] of Object.entries(initialFiles)) {
    repo.write(file, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return repo;
}
