import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ReviewState } from '../core/types';

/** Reads and writes the review state file atomically (temp file + rename). */
export class StateStore {
  /** The file content as this store last read or wrote it; null when there was no file. */
  private known: string | null | undefined;

  constructor(readonly filePath: string) {}

  async load(): Promise<ReviewState | null> {
    return this.parse(await this.read());
  }

  /**
   * Reads the file again when something else (another window, an agent, a hand edit) changed it
   * since this store last read or wrote it. Returns undefined when it did not change.
   */
  async loadIfChanged(): Promise<ReviewState | null | undefined> {
    const before = this.known;
    const raw = await this.read();
    return raw === before ? undefined : this.parse(raw);
  }

  private async read(): Promise<string | null> {
    try {
      this.known = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.known = null;
    }
    return this.known;
  }

  private parse(raw: string | null): ReviewState | null {
    if (raw === null) {
      return null;
    }
    const state = JSON.parse(raw) as ReviewState;
    const version = state.version as number;
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported state file version ${String(state.version)} in ${this.filePath}.`);
    }
    return withDefaults(state);
  }

  async save(state: ReviewState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    const raw = JSON.stringify(toSaved(state), null, 2) + '\n';
    await fs.writeFile(temp, raw, 'utf8');
    await fs.rename(temp, this.filePath);
    this.known = raw;
  }

  async remove(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
    this.known = null;
  }
}

/** Adds `.sift/` to .git/info/exclude once, so the state never gets committed. */
export async function excludeStateDir(gitDir: string): Promise<void> {
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  const entry = '.sift/';
  const current = await fs.readFile(excludeFile, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === entry)) {
    return;
  }
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludeFile, `${prefix}${entry}\n`, 'utf8');
}

/**
 * What gets saved: only decisions. Facts git knows (which files changed and how, which commits are
 * committed) are left out and read from git on load, so the saved state can't drift from the repo.
 */
function toSaved(state: ReviewState): unknown {
  return {
    ...state,
    version: 2,
    commits: state.commits.map(({ status: _status, sha: _sha, pushed: _pushed, revertedBy: _revertedBy, ...decision }) => decision),
    files: state.files.map(({ changeType: _type, adds: _adds, dels: _dels, binary: _binary, ...decision }) => decision),
  };
}

/** Fills fields added after M1 so older state files keep loading. */
function withDefaults(state: ReviewState): ReviewState {
  const legacyVersion = (state.version as number) === 1;
  state.version = 2;
  // Placeholders for what git says; the controller syncs with git before anything is shown.
  // A version 1 file still has commit status and sha, which the controller turns into commit refs once.
  for (const commit of state.commits) {
    if (!legacyVersion || commit.status !== 'committed') {
      commit.status = commit.id === state.session.currentCommitId ? 'in-review' : 'planned';
      delete commit.sha;
    }
    delete commit.pushed;
    delete commit.revertedBy;
  }
  for (const file of state.files) {
    file.changeType = file.changeType ?? 'modified';
    file.adds = file.adds ?? null;
    file.dels = file.dels ?? null;
    file.binary = file.binary ?? false;
  }
  delete (state.session as { lastHead?: string }).lastHead;
  state.threads = state.threads ?? [];
  state.session.showExplanations = state.session.showExplanations ?? false;
  // Before the AI became built in, its messages and rounds were Claude's, and a thread could wait on a Claude session.
  const legacy = state as unknown as { session: Record<string, unknown> };
  delete legacy.session.turn;
  delete legacy.session.pendingApproval;
  for (const iteration of state.iterations) {
    if ((iteration.author as string) === 'claude') {
      iteration.author = 'ai';
    }
  }
  for (const thread of state.threads) {
    delete (thread as { delivered?: boolean }).delivered;
    for (const message of thread.messages) {
      if ((message.author as string) === 'claude') {
        message.author = 'ai';
        message.model = message.model ?? 'Claude';
      }
    }
    if (thread.status === 'sent') {
      // Nothing is working on it after a restart.
      thread.status = 'open';
    }
  }
  return state;
}
