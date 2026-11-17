import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiService, applyEdits } from '../src/ai/AiService';
import { extractJson, numberDiff } from '../src/ai/prompts';
import type { AiProvider, AiRequest } from '../src/ai/types';
import { ReviewController } from '../src/controller/ReviewController';
import { GitRunner } from '../src/git/GitRunner';
import { SnapshotService } from '../src/git/SnapshotService';
import { StateStore } from '../src/state/StateStore';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;
let controller: ReviewController;
let answers: unknown[];
let prompts: string[];
let errors: string[];
let ai: AiService;

/** Answers with the queued answers in order and records the prompts. */
const fake: AiProvider = {
  name: 'Fake',
  async ask(request: AiRequest) {
    prompts.push(request.prompt);
    const next = answers.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next;
  },
};

beforeEach(async () => {
  answers = [];
  prompts = [];
  errors = [];
  repo = createRepo({ 'src/a.ts': 'const a = 1;\nexport default a;\n', 'src/b.ts': 'b\n' });
  const git = new GitRunner(repo.dir);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
  controller = new ReviewController(repo.dir, gitDir, git, snapshots, new StateStore(path.join(repo.dir, '.sift', 'state.json')), true);
  await controller.init();
  ai = new AiService(controller, async () => fake, { onBusyChange: () => undefined, onError: (m) => errors.push(m) });
  repo.write('src/a.ts', 'const a = 2;\nexport default a;\n');
  repo.write('src/b.ts', 'b changed\n');
  repo.write('src/c.ts', 'new file\n');
});

afterEach(() => {
  controller.dispose();
  repo.cleanup();
});

const plan = {
  commits: [
    {
      message: 'Bump a',
      intent: 'a is 2',
      files: ['src/a.ts'],
      explanations: [{ path: 'src/a.ts', line: 1, body: 'New value.' }],
    },
    { message: 'Rest', intent: '', files: ['src/b.ts', 'src/c.ts'], explanations: [] },
  ],
};

describe('planning with AI', () => {
  it('starts a session, sends numbered diffs, and applies the plan with explanations', async () => {
    answers.push(plan);

    const result = await ai.planCommits();

    expect(result).toEqual({ commits: 2, unassigned: 0, model: 'Fake' });
    expect(prompts[0]).toContain('- src/c.ts (added');
    expect(prompts[0]).toContain('    1 +const a = 2;');
    const model = controller.review!;
    expect(model.commitsInOrder().map((c) => c.message)).toEqual(['Bump a', 'Rest']);
    expect(model.state.threads).toMatchObject([
      { kind: 'explanation', path: 'src/a.ts', lineText: 'const a = 2;', messages: [{ author: 'ai', model: 'Fake' }] },
    ]);
  });

  it('retries once with the validation error', async () => {
    answers.push({ commits: [{ message: 'Only a', intent: '', files: ['src/a.ts'], explanations: [] }] }, plan);

    await ai.planCommits();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/rejected: Plan leaves out 2 changed file/);
  });
});

describe('asking AI in a thread', () => {
  beforeEach(async () => {
    answers.push(plan);
    await ai.planCommits();
    await controller.startCommit(controller.review!.commitsInOrder()[0].id);
  });

  it('answers a question in the thread without touching code', async () => {
    const thread = await controller.addComment('src/a.ts', 0, 'const a = 2;', 'Why 2?');
    answers.push({ reply: 'Because the spec says so.', edits: [] });

    expect(await ai.ask([thread.id])).toBe(1);
    expect(controller.review!.getThread(thread.id).status).toBe('sent');
    await ai.idle();

    expect(controller.review!.getThread(thread.id)).toMatchObject({
      status: 'answered',
      messages: [{ body: 'Why 2?' }, { author: 'ai', model: 'Fake', body: 'Because the spec says so.' }],
    });
    expect(prompts[1]).toContain('\n1 > const a = 2;');
    expect(prompts[1]).toContain('Developer: Why 2?');
    expect(readFileSync(path.join(repo.dir, 'src/a.ts'), 'utf8')).toBe('const a = 2;\nexport default a;\n');
  });

  it('applies the edits of a direction and starts a new round', async () => {
    const thread = await controller.addComment('src/a.ts', 0, 'const a = 2;', 'Use 3.');
    answers.push({ reply: 'Done.', edits: [{ path: 'src/a.ts', find: 'const a = 2;', replace: 'const a = 3;' }] });

    await ai.ask([thread.id]);
    await ai.idle();

    expect(readFileSync(path.join(repo.dir, 'src/a.ts'), 'utf8')).toBe('const a = 3;\nexport default a;\n');
    expect(controller.review!.getThread(thread.id).messages[1].body).toBe('Done.\n\n*Changed `src/a.ts`.*');
    expect(controller.review!.latestIteration(controller.review!.state.session.currentCommitId!)?.n).toBe(1);
  });

  it('puts the thread back to open with the reason when the AI fails', async () => {
    const thread = await controller.addComment('src/a.ts', 0, 'const a = 2;', 'Use 3.');
    answers.push(new Error('rate limited'));

    await ai.ask([thread.id]);
    await ai.idle();

    expect(controller.review!.getThread(thread.id)).toMatchObject({ status: 'open', error: 'rate limited' });
    expect(errors).toEqual(['rate limited']);
    expect(ai.busy).toBe(0);
  });
});

describe('applyEdits', () => {
  it('applies all edits or none, and stays inside the repository', async () => {
    await expect(applyEdits(repo.dir, [{ path: '../x', find: '', replace: 'x' }])).rejects.toThrow(/outside/);
    await expect(
      applyEdits(repo.dir, [
        { path: 'src/b.ts', find: 'b changed', replace: 'b fixed' },
        { path: 'src/a.ts', find: 'not there', replace: 'x' },
      ]),
    ).rejects.toThrow(/does not match/);
    expect(readFileSync(path.join(repo.dir, 'src/b.ts'), 'utf8')).toBe('b changed\n');

    expect(await applyEdits(repo.dir, [{ path: 'src/new.ts', find: '', replace: 'n\n' }])).toEqual(['src/new.ts']);
    expect(readFileSync(path.join(repo.dir, 'src/new.ts'), 'utf8')).toBe('n\n');
  });
});

describe('prompt helpers', () => {
  it('numbers context and added lines with their line in the new file', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new';
    expect(numberDiff(diff).split('\n')).toEqual(['@@ -1,2 +1,2 @@', '    1  keep', '      -old', '    2 +new']);
  });

  it('extracts JSON from bare, fenced, or chatty answers', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here you go {"a":3} hope it helps')).toEqual({ a: 3 });
    expect(() => extractJson('no json')).toThrow(/did not answer with JSON/);
  });
});
