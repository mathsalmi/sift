import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ReviewState } from '../core/types';

/** Reads and writes the review state file atomically (temp file + rename). */
export class StateStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<ReviewState | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    const state = JSON.parse(raw) as ReviewState;
    if (state.version !== 1) {
      throw new Error(`Unsupported state file version ${String(state.version)} in ${this.filePath}.`);
    }
    return withDefaults(state);
  }

  async save(state: ReviewState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fs.rename(temp, this.filePath);
  }

  async remove(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
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

/** Fills fields added after M1 so older state files keep loading. */
function withDefaults(state: ReviewState): ReviewState {
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
