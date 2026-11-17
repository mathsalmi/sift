import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewController } from '../src/controller/ReviewController';
import { GitRunner } from '../src/git/GitRunner';
import { SnapshotService } from '../src/git/SnapshotService';
import { StateStore } from '../src/state/StateStore';
import { createRepo, type TempRepo } from './helpers';
import { executed, type Uri } from './vscode-mock';

let repo: TempRepo;
let controller: ReviewController;

async function makeController(): Promise<ReviewController> {
  const git = new GitRunner(repo.dir);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
  const store = new StateStore(path.join(repo.dir, '.sift', 'state.json'));
  const c = new ReviewController(repo.dir, gitDir, git, snapshots, store, true);
  await c.init();
  return c;
}

function writePlan(plan: unknown): void {
  repo.write('.sift/plan.json', JSON.stringify(plan));
}

function lastDiff(): { left: Uri; right: Uri; title: string } {
  const call = executed.filter((e) => e.id === 'vscode.diff').at(-1);
  if (!call) {
    throw new Error('no diff opened');
  }
  const [left, right, title] = call.args as [Uri, Uri, string];
  return { left, right, title };
}

beforeEach(async () => {
  executed.length = 0;
  repo = createRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  controller = await makeController();
});

afterEach(() => repo.cleanup());

describe('ReviewController end to end', () => {
  it('runs plan → review rounds → approve → next commit → done', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    repo.write('src/c.ts', 'c new\n');

    expect(await controller.startReview()).toBe(3);
    expect(readFileSync(path.join(repo.dir, '.git/info/exclude'), 'utf8')).toContain('.sift/');

    writePlan({
      commits: [
        { message: 'Change a and add c', files: ['src/a.ts', 'src/c.ts'] },
        { message: 'Change b', files: ['src/b.ts'] },
      ],
    });
    expect(await controller.loadPlan()).toEqual({ commits: 2, unassigned: 0 });

    const model = controller.review!;
    const [first, second] = model.commitsInOrder();

    // Round 0
    await controller.startCommit(first.id);
    expect(model.iterationsOf(first.id).map((i) => i.n)).toEqual([0]);
    await controller.openDiff('src/a.ts');
    expect(lastDiff().left.query).toBe('HEAD');
    expect(model.findFile('src/a.ts')?.status).toBe('in-progress');
    await controller.setStatus(['src/a.ts', 'src/c.ts'], 'done');

    // A fix arrives (e.g. from Claude): new round
    repo.write('src/a.ts', 'a fixed\n');
    expect(await controller.takeSnapshot('ai')).toBe(1);
    expect(model.findFile('src/a.ts')).toMatchObject({ status: 'in-progress', changedInIteration: 1 });
    expect(model.findFile('src/c.ts')?.status).toBe('done');

    // "This round" diff = v0 ↔ working tree
    await controller.openDiff('src/a.ts');
    const v0 = model.iterationsOf(first.id)[0];
    expect(lastDiff().left.query).toBe(v0.treeSha);
    expect(lastDiff().title).toContain('v0 ↔ v1');

    // Cumulative diff = HEAD ↔ working tree
    controller.diffMode = 'cumulative';
    await controller.openDiff('src/a.ts');
    expect(lastDiff().left.query).toBe('HEAD');
    controller.diffMode = 'round';

    // Nothing changed → no new round
    expect(await controller.takeSnapshot('user')).toBeNull();

    // Approve
    await expect(controller.approveCurrent()).rejects.toThrow(/not approved yet/);
    await controller.setStatus(['src/a.ts'], 'done');
    const result = await controller.approveCurrent();
    expect(result.nextCommitId).toBe(second.id);
    expect(repo.git('show', '--name-only', '--format=%s', 'HEAD')).toBe('Change a and add c\n\nsrc/a.ts\nsrc/c.ts\n');
    expect(repo.git('show', 'HEAD:src/a.ts')).toBe('a fixed\n');
    expect(model.state.session.currentCommitId).toBe(second.id);
    expect(model.iterationsOf(second.id).map((i) => i.n)).toEqual([0]);

    // Last commit
    await controller.setStatus(['src/b.ts'], 'done');
    const final = await controller.approveCurrent();
    expect(final.nextCommitId).toBeNull();
    expect(model.state.session.status).toBe('done');
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('persists state and resumes it in a new controller', async () => {
    repo.write('src/a.ts', 'changed\n');
    await controller.startReview();
    const id = await controller.newCommit('Only commit');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);
    await controller.setStatus(['src/a.ts'], 'done');

    const resumed = await makeController();

    expect(resumed.review?.state.session.currentCommitId).toBe(id);
    expect(resumed.review?.findFile('src/a.ts')?.status).toBe('done');
    expect(resumed.review?.iterationsOf(id)).toHaveLength(1);
  });

  it('refuses to approve when HEAD moved outside the extension', async () => {
    repo.write('src/a.ts', 'changed\n');
    repo.write('other.txt', 'x\n');
    await controller.startReview();
    const id = await controller.newCommit('A');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);
    await controller.setStatus(['src/a.ts'], 'done');

    repo.git('add', 'other.txt');
    repo.git('commit', '-q', '-m', 'outside');

    await expect(controller.approveCurrent()).rejects.toThrow(/HEAD moved/);
    await controller.resyncHead();
    await expect(controller.approveCurrent()).resolves.toMatchObject({ nextCommitId: null });
  });

  it('marks planned commits committed outside Sift on refresh, so none is left empty', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    await controller.startReview();
    writePlan({ commits: [{ message: 'Change a', files: ['src/a.ts'] }, { message: 'Change b', files: ['src/b.ts'] }] });
    await controller.loadPlan();

    repo.git('add', 'src/a.ts');
    repo.git('commit', '-q', '-m', 'Change a');
    repo.git('add', 'src/b.ts');
    repo.git('commit', '-q', '-m', 'Change b');

    const outcome = await controller.refresh();
    const model = controller.review!;
    expect(outcome.committedOutside).toEqual(['Change a', 'Change b']);
    expect(model.commitsInOrder().map((c) => c.status)).toEqual(['committed', 'committed']);
    expect(model.commitsInOrder()[1].sha).toBe(repo.git('rev-parse', 'HEAD').trim());
    expect(model.state.session.status).toBe('done');
  });

  it('abort removes state and snapshot refs but keeps files', async () => {
    repo.write('src/a.ts', 'changed\n');
    await controller.startReview();
    const id = await controller.newCommit('A');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);

    await controller.abort();

    expect(controller.review).toBeNull();
    expect(repo.git('for-each-ref', 'refs/sift')).toBe('');
    expect(repo.git('status', '--porcelain')).toBe(' M src/a.ts\n');
  });
});

describe('plan file pickup', () => {
  it('starts a session and applies a new plan file without any click, once', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    writePlan({
      commits: [
        {
          message: 'Change a',
          files: ['src/a.ts'],
          explanations: [{ path: 'src/a.ts', line: 1, body: 'Renamed for clarity.' }],
        },
      ],
    });

    expect(await controller.checkPlanFile()).toEqual({ result: 'applied', commits: 1, unassigned: 1, started: true });
    const model = controller.review!;
    expect(model.commitsInOrder().map((c) => c.message)).toEqual(['Change a']);
    expect(model.state.threads).toMatchObject([{ kind: 'explanation', path: 'src/a.ts', line: 0, lineText: 'a changed' }]);
    expect(model.state.session.showExplanations).toBe(true);

    // Same file again: nothing to do.
    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });

    // A different plan while one is under review: ask first.
    writePlan({ commits: [{ message: 'Everything', files: ['src/a.ts', 'src/b.ts'] }] });
    const outcome = await controller.checkPlanFile();
    expect(outcome.result).toBe('needs-confirm');
    await controller.dismissPlanFile((outcome as { hash: string }).hash);
    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });
  });

  it('abort deletes the plan file so it does not start a new session', async () => {
    repo.write('src/a.ts', 'a changed\n');
    writePlan({ commits: [{ message: 'A', files: ['src/a.ts'] }] });
    await controller.checkPlanFile();

    await controller.abort();

    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });
    expect(controller.review).toBeNull();
  });
});
