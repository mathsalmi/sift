import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GitRunner } from './GitRunner';

export interface Snapshot {
  treeSha: string;
  commitSha: string;
  ref: string;
}

/** Identity used only for the private snapshot objects, never for real commits. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Sift',
  GIT_AUTHOR_EMAIL: 'sift@localhost',
  GIT_COMMITTER_NAME: 'Sift',
  GIT_COMMITTER_EMAIL: 'sift@localhost',
};

export const REF_ROOT = 'refs/sift';

/**
 * Freezes the working tree as git objects without touching the real index,
 * and reads files back from any snapshot.
 */
export class SnapshotService {
  private constructor(
    private readonly git: GitRunner,
    private readonly gitDir: string,
    private readonly maxNewFileBytes: number,
  ) {}

  static async create(git: GitRunner, maxNewFileBytes: number): Promise<SnapshotService> {
    const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
    return new SnapshotService(git, gitDir, maxNewFileBytes);
  }

  /** Builds a tree of the current working tree (respecting .gitignore) and returns its sha. */
  async writeWorkingTree(): Promise<string> {
    const indexFile = path.join(this.gitDir, 'sift', 'index');
    await fs.mkdir(path.dirname(indexFile), { recursive: true });
    const env = { GIT_INDEX_FILE: indexFile };

    await this.git.run(['read-tree', 'HEAD'], { env });
    await this.git.run(['add', '-A'], { env });
    await this.dropLargeNewFiles(env);
    return (await this.git.run(['write-tree'], { env })).trim();
  }

  /** Stores a tree under a ref so `git gc` never prunes it. */
  async store(treeSha: string, ref: string, message: string): Promise<Snapshot> {
    const commitSha = (
      await this.git.run(['commit-tree', treeSha, '-p', 'HEAD', '-m', message], { env: SNAPSHOT_IDENTITY })
    ).trim();
    await this.git.run(['update-ref', ref, commitSha]);
    return { treeSha, commitSha, ref };
  }

  /** File content at a tree-ish (snapshot tree sha, commit sha or HEAD); null when the file is absent there. */
  async show(treeish: string, filePath: string): Promise<string | null> {
    const result = await this.git.exec(['show', `${treeish}:${filePath}`], { okCodes: [0, 128] });
    if (result.exitCode !== 0) {
      return null;
    }
    return result.stdout;
  }

  /** Paths that differ between two tree-ishes. */
  async changedPaths(from: string, to: string): Promise<string[]> {
    const output = await this.git.run(['diff', '--name-only', '--no-renames', '-z', from, to]);
    return output.split('\0').filter((token) => token.length > 0);
  }

  async deleteRefs(prefix: string): Promise<number> {
    const output = await this.git.run(['for-each-ref', '--format=%(refname)', prefix]);
    const refs = output.split('\n').filter((line) => line.length > 0);
    for (const ref of refs) {
      await this.git.run(['update-ref', '-d', ref]);
    }
    return refs.length;
  }

  private async dropLargeNewFiles(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.maxNewFileBytes <= 0) {
      return;
    }
    const output = await this.git.run(['diff', '--cached', '--name-only', '--diff-filter=A', '-z', 'HEAD'], { env });
    const added = output.split('\0').filter((token) => token.length > 0);
    const tooLarge: string[] = [];
    for (const filePath of added) {
      const stat = await fs.stat(path.join(this.git.cwd, filePath)).catch(() => null);
      if (stat && stat.size > this.maxNewFileBytes) {
        tooLarge.push(filePath);
      }
    }
    if (tooLarge.length === 0) {
      return;
    }
    await this.git.run(['rm', '--cached', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      env,
      input: tooLarge.join('\0') + '\0',
    });
  }
}

export function snapshotRef(sessionId: string, commitId: string, n: number): string {
  return `${REF_ROOT}/${sessionId}/${commitId}/v${n}`;
}

export function sessionRefPrefix(sessionId: string): string {
  return `${REF_ROOT}/${sessionId}`;
}
