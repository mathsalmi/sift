import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ReviewController } from '../controller/ReviewController';
import { resolveAnchor } from '../core/anchor';
import type { PlanInput } from '../core/types';
import { ANSWER_SCHEMA, PLAN_SCHEMA, planPrompt, threadPrompt, type PlanFile } from './prompts';
import type { AiProvider, FileEdit, ThreadAnswer } from './types';

export interface AiServiceEvents {
  /** Something about running work changed (for the status bar). */
  onBusyChange(): void;
  /** An answer could not be produced. */
  onError(message: string): void;
}

/**
 * Sift's own AI work: planning commits and answering comment threads.
 * Thread answers run one at a time, so two answers never edit the same file at once.
 */
export class AiService {
  private queue: Promise<void> = Promise.resolve();
  private readonly running = new Map<string, AbortController>();
  private planning: AbortController | null = null;

  constructor(
    private readonly controller: ReviewController,
    private readonly provider: () => Promise<AiProvider>,
    private readonly events: AiServiceEvents,
  ) {}

  /** Threads waiting or being answered, plus a running plan. */
  get busy(): number {
    return this.running.size + (this.planning ? 1 : 0);
  }

  get isPlanning(): boolean {
    return this.planning !== null;
  }

  dispose(): void {
    this.planning?.abort();
    for (const abort of this.running.values()) {
      abort.abort();
    }
  }

  // ---- plan ----

  /** Asks the AI for a plan of every pending file (with explanations) and applies it. Starts a session if needed. */
  async planCommits(signal?: AbortSignal): Promise<{ commits: number; unassigned: number; model: string }> {
    if (this.planning) {
      throw new Error('The AI is already planning.');
    }
    const abort = new AbortController();
    signal?.addEventListener('abort', () => abort.abort());
    this.planning = abort;
    this.events.onBusyChange();
    try {
      if (!(await this.controller.ensureSession())) {
        await this.controller.refresh();
      }
      const review = this.controller.review!;
      const committed = new Set(review.state.commits.filter((c) => c.status === 'committed').map((c) => c.id));
      const pending = review.state.files.filter((f) => !f.commitId || !committed.has(f.commitId));
      if (pending.length === 0) {
        throw new Error('There are no uncommitted changes to plan.');
      }
      const files: PlanFile[] = [];
      // A file split across commits has one entry per part: the AI sees it once, whole.
      const seen = new Set<string>();
      for (const file of [...pending].sort((a, b) => a.path.localeCompare(b.path))) {
        if (seen.has(file.path)) {
          continue;
        }
        seen.add(file.path);
        files.push({ file, diff: file.binary ? '' : await this.controller.diffOf(file.path) });
      }

      const provider = await this.provider();
      let prompt = planPrompt(path.basename(this.controller.root), files);
      // One retry with the validation error, which fixes most slips (a missing file, a bad line number).
      for (let attempt = 0; ; attempt++) {
        const answer = await provider.ask({ prompt, schema: PLAN_SCHEMA, cwd: this.controller.root }, abort.signal);
        try {
          const plan = asPlan(answer);
          await this.controller.setPlan(plan, provider.name);
          return { commits: plan.commits.length, unassigned: this.controller.review?.filesOf(null).length ?? 0, model: provider.name };
        } catch (error) {
          if (attempt >= 1 || abort.signal.aborted) {
            throw error;
          }
          prompt += `\n\nYour previous answer was rejected: ${(error as Error).message}\nFix it and answer again.`;
        }
      }
    } finally {
      this.planning = null;
      this.events.onBusyChange();
    }
  }

  cancelPlanning(): void {
    this.planning?.abort();
  }

  // ---- threads ----

  /** Asks the AI about the given threads (or every open comment). Returns how many were queued. */
  async ask(threadIds?: string[]): Promise<number> {
    const threads = await this.controller.startAsking(threadIds);
    for (const thread of threads) {
      const abort = new AbortController();
      this.running.set(thread.id, abort);
      this.queue = this.queue.then(() => this.answer(thread.id, abort.signal));
    }
    this.events.onBusyChange();
    return threads.length;
  }

  isAnswering(threadId: string): boolean {
    return this.running.has(threadId);
  }

  cancel(threadId: string): void {
    this.running.get(threadId)?.abort();
  }

  /** Resolves when every queued answer is done (for tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async answer(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted) {
        throw new Error('Cancelled.');
      }
      const review = this.controller.review;
      const thread = review?.state.threads.find((t) => t.id === threadId);
      if (!review || !thread) {
        return; // deleted meanwhile
      }
      const lines = await this.controller.readLines(thread.path);
      const anchor = resolveAnchor(lines, thread.line, thread.lineText);
      const commit = thread.commitId ? review.getCommit(thread.commitId) : null;
      const prompt = threadPrompt(path.basename(this.controller.root), {
        thread,
        lines,
        line: anchor.line,
        diff: await this.controller.diffOf(thread.path),
        commit: commit ? { message: commit.message, intent: commit.intent } : null,
      });

      const provider = await this.provider();
      const answer = asAnswer(await provider.ask({ prompt, schema: ANSWER_SCHEMA, cwd: this.controller.root }, signal));
      if (signal.aborted) {
        throw new Error('Cancelled.');
      }
      const changed = await applyEdits(this.controller.root, answer.edits ?? []);
      const note = changed.length > 0 ? `\n\n*Changed ${changed.map((p) => `\`${p}\``).join(', ')}.*` : '';
      if (!this.controller.review?.state.threads.some((t) => t.id === threadId)) {
        return;
      }
      await this.controller.replyAsAi(threadId, `${answer.reply}${note}`, provider.name);
      if (changed.length > 0) {
        await this.controller.refresh();
        if (this.controller.review?.currentCommit()) {
          // A new round, so "this round" diffs show exactly what the AI changed.
          await this.controller.takeSnapshot('ai').catch(() => null);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      await this.controller.failAsking(threadId, message).catch(() => undefined);
      if (!signal.aborted) {
        this.events.onError(message);
      }
    } finally {
      this.running.delete(threadId);
      this.events.onBusyChange();
    }
  }
}

function asPlan(answer: unknown): PlanInput {
  const plan = answer as PlanInput;
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.commits)) {
    throw new Error('The answer has no "commits" array.');
  }
  return plan;
}

function asAnswer(answer: unknown): ThreadAnswer {
  const result = answer as ThreadAnswer;
  if (!result || typeof result.reply !== 'string' || !result.reply.trim()) {
    throw new Error('The AI answered without a reply.');
  }
  if (result.edits !== undefined && !Array.isArray(result.edits)) {
    throw new Error('The AI answered with invalid edits.');
  }
  return result;
}

/**
 * Applies search/replace edits inside the repository: all of them or none.
 * Returns the changed paths.
 */
export async function applyEdits(root: string, edits: FileEdit[]): Promise<string[]> {
  const contents = new Map<string, string>();
  for (const edit of edits) {
    if (typeof edit?.path !== 'string' || typeof edit.find !== 'string' || typeof edit.replace !== 'string') {
      throw new Error('The AI answered with an invalid edit.');
    }
    const relative = edit.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const full = path.resolve(root, relative);
    if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full)) || relative.startsWith('.git/')) {
      throw new Error(`The AI tried to edit ${edit.path}, outside the repository.`);
    }
    const current = contents.get(relative) ?? (await fs.readFile(full, 'utf8').catch(() => null));
    if (edit.find === '') {
      if (current !== null && current !== '') {
        throw new Error(`The AI tried to create ${relative}, which already exists.`);
      }
      contents.set(relative, edit.replace);
      continue;
    }
    if (current === null) {
      throw new Error(`The AI tried to edit ${relative}, which does not exist.`);
    }
    const first = current.indexOf(edit.find);
    if (first < 0) {
      throw new Error(`The AI's edit to ${relative} does not match the file. Ask again.`);
    }
    if (current.indexOf(edit.find, first + 1) >= 0) {
      throw new Error(`The AI's edit to ${relative} matches more than one place. Ask again.`);
    }
    contents.set(relative, current.slice(0, first) + edit.replace + current.slice(first + edit.find.length));
  }
  for (const [relative, content] of contents) {
    const full = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return [...contents.keys()];
}
