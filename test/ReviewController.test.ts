import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(existsSync(path.join(repo.dir, '.sift/plan.json'))).toBe(false);

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

    // A file the round didn't change shows its whole change instead of an empty diff
    await controller.openDiff('src/c.ts');
    expect(lastDiff().left.query).toBe('HEAD');

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

  it('approves after an unrelated commit made outside Sift', async () => {
    repo.write('src/a.ts', 'changed\n');
    repo.write('other.txt', 'x\n');
    await controller.startReview();
    const id = await controller.newCommit('A');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);
    await controller.setStatus(['src/a.ts'], 'done');

    repo.git('add', 'other.txt');
    repo.git('commit', '-q', '-m', 'outside');

    await expect(controller.approveCurrent()).resolves.toMatchObject({ nextCommitId: null });
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('A');
  });

  it('refuses to commit a file that changed after it was approved', async () => {
    repo.write('src/a.ts', 'changed\n');
    await controller.startReview();
    const id = await controller.newCommit('A');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);
    await controller.setStatus(['src/a.ts'], 'done');

    repo.write('src/a.ts', 'changed again\n');

    await expect(controller.approveCurrent()).rejects.toThrow(/changed after you approved/);
    expect(controller.review?.findFile('src/a.ts')).toMatchObject({ status: 'in-progress', changedSinceApproval: true });
  });

  it('diffs a file edited after approval against what was approved', async () => {
    repo.write('src/a.ts', 'one\ntwo\n');
    await controller.startReview();
    const id = await controller.newCommit('A');
    await controller.moveFiles(['src/a.ts'], id);
    await controller.startCommit(id);
    await controller.setStatus(['src/a.ts'], 'done');

    repo.write('src/a.ts', 'one\nTWO\n');
    await controller.refresh();
    await controller.openDiff('src/a.ts');

    const { left, title } = lastDiff();
    expect(title).toBe('a.ts (approved ↔ now · changed since approval)');
    expect(left.query).toMatch(/^blob:[0-9a-f]{40}$/);
    const git = new GitRunner(repo.dir);
    expect(await git.run(['cat-file', 'blob', left.query.slice(5)])).toBe('one\ntwo\n');

    // Approving again goes back to the whole change.
    await controller.setStatus(['src/a.ts'], 'done');
    await controller.openDiff('src/a.ts');
    expect(lastDiff().title).toBe('a.ts (HEAD ↔ v0 · cumulative)');
  });

  it('saves only decisions and reads the rest back from git', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    await controller.startReview();
    writePlan({ commits: [{ message: 'Change a', files: ['src/a.ts'] }, { message: 'Change b', files: ['src/b.ts'] }] });
    await controller.loadPlan();
    const [a] = controller.review!.commitsInOrder();
    await controller.startCommit(a.id);
    await controller.setStatus(['src/a.ts'], 'done');
    const { sha } = await controller.approveCurrent();

    const saved = JSON.parse(readFileSync(path.join(repo.dir, '.sift', 'state.json'), 'utf8'));
    expect(saved.version).toBe(2);
    expect(saved.commits[0]).not.toHaveProperty('status');
    expect(saved.commits[0]).not.toHaveProperty('sha');
    expect(saved.files[0]).not.toHaveProperty('changeType');
    expect(saved.session).not.toHaveProperty('lastHead');
    expect(repo.git('show-ref', `refs/sift/${saved.session.id}/${a.id}/commit`)).toContain(sha);

    const resumed = await makeController();
    expect(resumed.review?.commitsInOrder().map((c) => [c.status, c.sha])).toEqual([
      ['committed', sha],
      ['in-review', undefined],
    ]);
    expect(resumed.review?.findFile('src/a.ts')).toMatchObject({ changeType: 'modified', adds: 1, dels: 1 });

    // Undoing the commit puts it back in the plan.
    repo.git('reset', '-q', 'HEAD~1');
    await resumed.refresh();
    expect(resumed.review?.getCommit(a.id).status).toBe('planned');
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

  it('does not redraw on a refresh that changes nothing', async () => {
    repo.write('src/a.ts', 'changed\n');
    await controller.startReview();
    let redraws = 0;
    controller.onDidChange(() => redraws++);

    await controller.refresh();
    expect(redraws).toBe(0);

    repo.write('src/b.ts', 'changed\n');
    await controller.refresh();
    expect(redraws).toBe(1);
  });

  it('reloads the saved state when something else changed it, but not after its own writes', async () => {
    repo.write('src/a.ts', 'changed\n');
    await controller.startReview();
    expect(await controller.reloadState()).toBe(false);

    const other = await makeController();
    await other.newCommit('Made elsewhere');

    expect(await controller.reloadState()).toBe(true);
    expect(controller.review?.commitsInOrder().map((c) => c.message)).toEqual(['Made elsewhere']);
    expect(await controller.reloadState()).toBe(false);
  });

  it('converts a version 1 state, keeping its committed commits', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    await controller.startReview();
    writePlan({ commits: [{ message: 'Change a', files: ['src/a.ts'] }, { message: 'Change b', files: ['src/b.ts'] }] });
    await controller.loadPlan();
    const [a] = controller.review!.commitsInOrder();
    await controller.startCommit(a.id);
    await controller.setStatus(['src/a.ts'], 'done');
    const { sha } = await controller.approveCurrent();

    // What version 1 saved: derived fields included, no commit refs.
    const state = controller.review!.state;
    const sessionId = state.session.id;
    repo.git('update-ref', '-d', `refs/sift/${sessionId}/${a.id}/commit`);
    repo.write('.sift/state.json', JSON.stringify({ ...state, version: 1, session: { ...state.session, lastHead: sha } }));

    const resumed = await makeController();
    expect(resumed.review?.getCommit(a.id)).toMatchObject({ status: 'committed', sha });
    expect(repo.git('show-ref', `refs/sift/${sessionId}/${a.id}/commit`)).toContain(sha);
  });

  it('versions only the files that changed, and skips snapshots that change none of the commit', async () => {
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    repo.write('src/c.ts', 'c new\n');
    await controller.startReview();
    writePlan({ commits: [{ message: 'AB', files: ['src/a.ts', 'src/b.ts'] }, { message: 'C', files: ['src/c.ts'] }] });
    await controller.loadPlan();
    const model = controller.review!;
    const [ab] = model.commitsInOrder();
    await controller.startCommit(ab.id);

    repo.write('src/c.ts', 'c changed\n');
    expect(await controller.takeSnapshot('user')).toBeNull();

    repo.write('src/b.ts', 'b fixed\n');
    expect(await controller.takeSnapshot('ai')).toBe(1);
    repo.write('src/b.ts', 'b fixed again\n');
    expect(await controller.takeSnapshot('ai')).toBe(2);

    expect(model.fileVersion(model.findFile('src/a.ts')!)).toBe(0);
    expect(model.fileVersion(model.findFile('src/b.ts')!)).toBe(2);
    await controller.openDiff('src/b.ts');
    expect(lastDiff().title).toBe('b.ts (v1 ↔ v2 · latest change)');
    await controller.openDiff('src/a.ts');
    expect(lastDiff().title).toBe('a.ts (HEAD ↔ v0 · cumulative)');
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

    // Applied plans are deleted: the plan lives in the state.
    expect(existsSync(path.join(repo.dir, '.sift/plan.json'))).toBe(false);
    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });

    // An updated plan that keeps "Change a" applies without asking, and "Change a" keeps its review.
    const id = model.commitsInOrder()[0].id;
    model.setStatus(['src/a.ts'], 'in-progress');
    writePlan({
      commits: [
        { message: 'Change a', intent: 'Clearer names', files: ['src/a.ts'] },
        { message: 'Change b', files: ['src/b.ts'], dependsOn: [1] },
      ],
    });
    expect(await controller.checkPlanFile()).toMatchObject({ result: 'applied', commits: 2, unassigned: 0 });
    const [a, b] = controller.review!.commitsInOrder();
    expect([a.id, a.intent, b.message, b.dependsOn]).toEqual([id, 'Clearer names', 'Change b', [id]]);
    expect(controller.review!.filesOf(id).map((f) => [f.path, f.status])).toEqual([['src/a.ts', 'in-progress']]);
    expect(controller.review!.state.threads).toHaveLength(1);

    // A plan that drops a commit already under review: ask first.
    writePlan({ commits: [{ message: 'Only b', files: ['src/b.ts'] }] });
    const outcome = await controller.checkPlanFile();
    expect(outcome).toEqual({ result: 'needs-confirm', lost: ['Change a'] });
    expect(existsSync(path.join(repo.dir, '.sift/plan.json'))).toBe(true);
    await controller.discardPlanFile();
    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });
    expect(controller.review!.commitsInOrder().map((c) => c.message)).toEqual(['Change a', 'Change b']);
  });

  it('keeps a plan file that fails, so it can be fixed', async () => {
    repo.write('src/a.ts', 'a changed\n');
    await controller.startReview();
    writePlan({ commits: [{ message: 'X', files: ['nope.ts'] }] });
    await expect(controller.checkPlanFile()).rejects.toThrow(/not a changed file/);
    expect(existsSync(path.join(repo.dir, '.sift/plan.json'))).toBe(true);
  });

  it('deletes a plan file a session from before applied already', async () => {
    repo.write('src/a.ts', 'a changed\n');
    writePlan({ commits: [{ message: 'A', files: ['src/a.ts'] }] });
    await controller.checkPlanFile();
    const raw = JSON.stringify({ commits: [{ message: 'Old', files: ['src/a.ts'] }] });
    writePlan(JSON.parse(raw));
    const legacy = controller.review!.state.session as { planFileHash?: string };
    legacy.planFileHash = createHash('sha256').update(raw).digest('hex').slice(0, 16);

    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });
    expect(existsSync(path.join(repo.dir, '.sift/plan.json'))).toBe(false);
    expect(controller.review!.commitsInOrder().map((c) => c.message)).toEqual(['A']);
    expect(legacy.planFileHash).toBeUndefined();
  });

  it('loads a state file changed outside Sift instead of overwriting it', async () => {
    repo.write('src/a.ts', 'a changed\n');
    writePlan({ commits: [{ message: 'A', files: ['src/a.ts'] }] });
    await controller.checkPlanFile();
    const saved = JSON.parse(readFileSync(controller.statePath, 'utf8'));
    saved.commits[0].message = 'Edited outside';
    writeFileSync(controller.statePath, JSON.stringify(saved));

    // The window still holds the old plan; its next save must not clobber the outside edit.
    await expect(controller.newCommit('B')).rejects.toThrow('changed outside this window');
    expect(controller.review!.commitsInOrder().map((c) => c.message)).toEqual(['Edited outside']);
    await controller.newCommit('B');
    expect(controller.review!.commitsInOrder().map((c) => c.message)).toEqual(['Edited outside', 'B']);
  });

  it('abort deletes the plan file so it does not start a new session', async () => {
    repo.write('src/a.ts', 'a changed\n');
    writePlan({ commits: [{ message: 'A', files: ['src/a.ts'] }] });
    await controller.checkPlanFile();

    await controller.abort();

    expect(await controller.checkPlanFile()).toEqual({ result: 'none' });
    expect(controller.review).toBeNull();
  });

  it('commits every approved commit, undoes a local one and reverts a pushed one', async () => {
    const remote = createRepo();
    repo.git('remote', 'add', 'origin', remote.dir);
    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    repo.write('src/c.ts', 'c new\n');
    await controller.startReview();
    writePlan({
      commits: [
        { message: 'Change a', files: ['src/a.ts'] },
        { message: 'Change b', files: ['src/b.ts'], dependsOn: [1] },
        { message: 'Add c', files: ['src/c.ts'] },
      ],
    });
    await controller.loadPlan();
    const model = controller.review!;
    const [a, b, c] = model.commitsInOrder();
    await controller.setStatus(['src/b.ts', 'src/c.ts'], 'done');

    // b waits for a, which is not approved: only c is committed, and it moves up.
    expect(model.commitBatch().map((x) => x.id)).toEqual([c.id]);
    await controller.commitCommits([c.id]);
    expect(model.commitsInOrder().map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    await expect(controller.commitCommits([b.id])).rejects.toThrow(/builds on "Change a"/);
    // Unapproved files go in only when asked for.
    await expect(controller.commitCommits([a.id, b.id])).rejects.toThrow(/not approved yet/);
    await controller.commitCommits([a.id, b.id], { allowUnapproved: true });
    expect(repo.git('log', '--format=%s', '-3')).toBe('Change b\nChange a\nAdd c\n');
    expect(model.getCommit(b.id)).toMatchObject({ status: 'committed', pushed: false });

    // Undo a: b, made after it, comes back too, approvals kept.
    expect((await controller.commitsUndoneWith(a.id)).map((x) => x.subject)).toEqual(['Change b']);
    await controller.undoCommit(a.id);
    expect(model.getCommit(a.id).status).toBe('planned');
    expect(model.getCommit(b.id).status).toBe('planned');
    expect(model.findFile('src/b.ts')?.status).toBe('done');
    expect(repo.git('log', '--format=%s', '-1')).toBe('Add c\n');

    // Once pushed, c can't be undone, only reverted.
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/feature');
    repo.git('fetch', '-q', 'origin');
    await controller.refresh();
    expect(model.getCommit(c.id).pushed).toBe(true);
    await expect(controller.undoCommit(c.id)).rejects.toThrow(/was pushed/);
    const revert = await controller.revertCommit(c.id);
    expect(model.getCommit(c.id)).toMatchObject({ status: 'committed', revertedBy: revert });
    expect(repo.git('log', '--format=%s', '-1')).toMatch(/^Revert "Add c"/);
    remote.cleanup();
  });
});
