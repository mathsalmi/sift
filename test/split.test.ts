import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewController } from '../src/controller/ReviewController';
import { GitRunner } from '../src/git/GitRunner';
import { SnapshotService } from '../src/git/SnapshotService';
import { StateStore } from '../src/state/StateStore';
import { createRepo, type TempRepo } from './helpers';
import { executed, TabInputTextDiff, Uri, window } from './vscode-mock';

let repo: TempRepo;
let controller: ReviewController;
const lines = (change: (i: number) => string | null = () => null) =>
  Array.from({ length: 30 }, (_, i) => change(i + 1) ?? `line ${i + 1}`).join('\n') + '\n';

async function makeController(): Promise<ReviewController> {
  const git = new GitRunner(repo.dir);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
  const c = new ReviewController(repo.dir, gitDir, git, snapshots, new StateStore(path.join(repo.dir, '.sift', 'state.json')), true);
  await c.init();
  return c;
}

/** a.txt with changes on lines 2 and 20, b.txt changed; planned as one commit "A" with both files. */
async function planned(): Promise<{ a: string }> {
  repo.write('a.txt', lines((i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : null)));
  repo.write('b.txt', 'b2\n');
  await controller.startReview();
  await controller.setPlan({ commits: [{ message: 'A', files: ['a.txt', 'b.txt'] }] });
  return { a: controller.review!.commitsInOrder()[0].id };
}

const read = (file: string) => readFileSync(path.join(repo.dir, file), 'utf8');

beforeEach(async () => {
  executed.length = 0;
  window.activeTextEditor = undefined;
  window.tabGroups.activeTabGroup.activeTab = undefined;
  repo = createRepo({ 'a.txt': lines(), 'b.txt': 'b\n' });
  controller = await makeController();
});

afterEach(() => repo.cleanup());

describe('splitting a file across commits', () => {
  it('moves one change to another commit, reviews and commits each part on its own', async () => {
    const { a } = await planned();
    const b = await controller.newCommit('B');
    const [first] = await controller.hunksOf('a.txt');

    await controller.moveHunks('a.txt', a, [first.key], b);

    const model = controller.review!;
    expect(model.isSplit('a.txt')).toBe(true);
    expect(model.findFile('a.txt', a)).toMatchObject({ part: { own: 1, total: 2 }, adds: 1, dels: 1 });
    expect(model.findFile('a.txt', b)).toMatchObject({ part: { own: 1, total: 2 }, hunks: [{ key: first.key }] });

    // Each part's diff shows the file without its own changes on the left.
    expect(await controller.partText('a.txt', b, false)).toBe(lines((i) => (i === 20 ? 'twenty' : null)));
    expect(await controller.partText('a.txt', a, false)).toBe(lines((i) => (i === 2 ? 'two' : null)));
    await controller.openDiff('a.txt', undefined, b);
    const diff = executed.filter((e) => e.id === 'vscode.diff').at(-1)!.args as [Uri, Uri, string];
    expect(diff[0].query).toMatch(new RegExp(`^part:${b}:`));
    expect(diff[2]).toContain('1 of 2 changes');

    // The diff of a part stands for that part.
    window.activeTextEditor = { document: { uri: Uri.file(path.join(repo.dir, 'a.txt')) } };
    window.tabGroups.activeTabGroup.activeTab = { input: new TabInputTextDiff(diff[0], diff[1]) };
    expect(controller.activeFileRef()).toEqual({ path: 'a.txt', commitId: b });

    // Approving a part covers its own changes; committing B commits only line 2.
    await controller.setStatus([{ path: 'a.txt', commitId: b }, { path: 'a.txt', commitId: a }], 'done');
    expect(model.findFile('a.txt', b)!.approvedBlob).toMatch(/^hunks:/);
    await controller.commitCommits([b]);
    expect(repo.git('show', 'HEAD:a.txt')).toBe(lines((i) => (i === 2 ? 'two' : null)));
    expect(read('a.txt')).toBe(lines((i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : null)));

    // What's left of a.txt is A's, whole again.
    expect(model.isSplit('a.txt')).toBe(false);
    expect(model.findFile('a.txt')).toMatchObject({ commitId: a, part: undefined, hunks: undefined });
    // Its approval was for the changes it still holds, so it stands, now for the file's content.
    expect(model.findFile('a.txt')!.status).toBe('done');
    expect(model.findFile('a.txt')!.approvedBlob).toMatch(/^[0-9a-f]{40}$/);
    await controller.setStatus(['b.txt'], 'done');
    await controller.commitCommits([a]);
    expect(repo.git('status', '--porcelain').trim()).toBe('');
  });

  it('keeps an edited change in its part and takes the part approval back', async () => {
    const { a } = await planned();
    const b = await controller.newCommit('B');
    const [first] = await controller.hunksOf('a.txt');
    await controller.moveHunks('a.txt', a, [first.key], b);
    await controller.setStatus([{ path: 'a.txt', commitId: b }, { path: 'a.txt', commitId: a }], 'done');

    repo.write('a.txt', lines((i) => (i === 2 ? 'TWO' : i === 20 ? 'twenty' : null)));
    const outcome = await controller.refresh();

    const model = controller.review!;
    expect(model.findFile('a.txt', b)).toMatchObject({ status: 'in-progress', part: { own: 1, total: 2 } });
    expect(model.findFile('a.txt', a)!.status).toBe('done');
    expect(outcome.unapproved).toEqual(['a.txt']);
    expect(await controller.partText('a.txt', b, true)).toBe(lines((i) => (i === 2 ? 'TWO' : null)));
  });

  it('joins the parts when one moves to the commit of the other, or the plan places the file', async () => {
    const { a } = await planned();
    const b = await controller.newCommit('B');
    const [first] = await controller.hunksOf('a.txt');
    await controller.moveHunks('a.txt', a, [first.key], b);

    await controller.moveFiles([{ path: 'a.txt', commitId: b }], a);

    const model = controller.review!;
    expect(model.isSplit('a.txt')).toBe(false);
    expect(model.pendingEntries('a.txt')).toHaveLength(1);
    await controller.moveHunks('a.txt', a, [first.key], b);
    await controller.setPlan({ commits: [{ message: 'All', files: ['a.txt', 'b.txt'] }] });
    expect(controller.review!.pendingEntries('a.txt')).toHaveLength(1);
  });

  it('discards the changes of a part only', async () => {
    const { a } = await planned();
    const b = await controller.newCommit('B');
    const [first] = await controller.hunksOf('a.txt');
    await controller.moveHunks('a.txt', a, [first.key], b);

    await controller.discard([{ path: 'a.txt', commitId: b }]);

    expect(read('a.txt')).toBe(lines((i) => (i === 20 ? 'twenty' : null)));
    expect(controller.review!.pendingEntries('a.txt')).toMatchObject([{ commitId: a, hunks: undefined }]);
  });

  it('splits a new file by paragraphs and commits each part on its own', async () => {
    const text = 'one\n1\n\n\ntwo\n2\n\nthree\n3';
    repo.write('new.txt', text);
    await controller.startReview();
    // Paragraph 2 starts at line 5, paragraph 3 at line 8; the plan gives paragraph 2 to B.
    await controller.setPlan({
      commits: [
        { message: 'A', files: ['new.txt'] },
        { message: 'B', files: [{ path: 'new.txt', lines: [6] }] },
      ],
    });
    const model = controller.review!;
    const [a, b] = model.commitsInOrder().map((c) => c.id);
    expect((await controller.hunksOf('new.txt')).map((h) => [h.newStart, h.newLines])).toEqual([
      [1, 4],
      [5, 3],
      [8, 2],
    ]);
    expect(model.findFile('new.txt', b)).toMatchObject({ part: { own: 1, total: 3 } });
    expect(await controller.partText('new.txt', a, true)).toBe('one\n1\n\n\nthree\n3');

    await controller.setStatus([{ path: 'new.txt', commitId: a }], 'done');
    await controller.commitCommits([a]);
    expect(repo.git('show', 'HEAD:new.txt')).toBe('one\n1\n\n\nthree\n3');
    expect(read('new.txt')).toBe(text);

    // What's left is B's paragraph, now an ordinary change to the file.
    expect(model.isSplit('new.txt')).toBe(false);
    expect(model.pendingEntries('new.txt')).toMatchObject([{ commitId: b, changeType: 'modified' }]);
    await controller.setStatus([{ path: 'new.txt', commitId: b }], 'done');
    await controller.commitCommits([b]);
    expect(repo.git('show', 'HEAD:new.txt')).toBe(text);
  });

  it('refuses to split deleted files', async () => {
    repo.remove('b.txt');
    await controller.startReview();
    await expect(
      controller.setPlan({ commits: [{ message: 'A', files: [{ path: 'b.txt', lines: [1] }] }, { message: 'B', files: ['b.txt'] }] }),
    ).rejects.toThrow(/it is deleted/);
  });
});

describe('renames', () => {
  const body = lines((i) => (i === 5 ? 'five' : null));

  it('shows a renamed file once, keeps its place in the plan, and commits and discards both names', async () => {
    repo.write('b.txt', 'b2\n');
    repo.write('a.txt', body);
    await controller.startReview();
    await controller.setPlan({ commits: [{ message: 'A', files: ['a.txt'] }, { message: 'B', files: ['b.txt'] }] });
    const model = controller.review!;
    const [a] = model.commitsInOrder().map((c) => c.id);

    // Renamed after planning (not staged, as an AI would do it): still A's file, under its new name.
    repo.remove('a.txt');
    repo.write('c.txt', body);
    await controller.refresh();
    expect(model.state.files.map((f) => [f.path, f.changeType, f.oldPath, f.commitId])).toEqual([
      ['c.txt', 'renamed', 'a.txt', a],
      ['b.txt', 'modified', undefined, expect.any(String)],
    ]);

    // A plan may name it by its old path.
    await controller.setPlan({ commits: [{ message: 'A', files: ['a.txt'] }, { message: 'B', files: ['b.txt'] }] });
    expect(model.findFile('c.txt')!.commitId).toBe(model.commitsInOrder()[0].id);

    // Its diff compares it with the old name in HEAD.
    await controller.openDiff('c.txt');
    const diff = executed.filter((e) => e.id === 'vscode.diff').at(-1)!.args as [Uri, Uri, string];
    expect([diff[0].path, diff[0].query]).toEqual(['/a.txt', 'HEAD']);

    await controller.discard(['c.txt']);
    expect(read('a.txt')).toBe(lines());
    expect(() => read('c.txt')).toThrow();

    repo.remove('a.txt');
    repo.write('c.txt', body);
    await controller.refresh();
    // Discarding emptied A, so plan it again.
    await controller.setPlan({ commits: [{ message: 'A', files: ['c.txt'] }, { message: 'B', files: ['b.txt'] }] });
    const commit = model.findFile('c.txt')!.commitId!;
    await controller.setStatus(['c.txt'], 'done');
    await controller.commitCommits([commit]);
    expect(repo.git('show', '--name-status', '--format=', '-M', 'HEAD').trim()).toMatch(/^R\d+\ta\.txt\tc\.txt$/);
    expect(model.getCommit(commit).status).toBe('committed');
    expect(model.filesOf(commit)).toMatchObject([{ path: 'c.txt', changeType: 'renamed', oldPath: 'a.txt' }]);
  });
});

describe('discard', () => {
  it('puts files back as in HEAD and deletes new ones', async () => {
    await planned();
    repo.write('new.txt', 'new\n');
    await controller.refresh();

    await controller.discard(['b.txt', 'new.txt']);

    expect(read('b.txt')).toBe('b\n');
    expect(controller.review!.state.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});

describe('amend', () => {
  it('folds files into a commit made in the review, and follows the commits it rewrites', async () => {
    const { a } = await planned();
    const b = await controller.newCommit('B');
    await controller.moveFiles(['b.txt'], b);
    await controller.setStatus(['a.txt', 'b.txt'], 'done');
    await controller.commitCommits([a, b]);
    const newerBefore = controller.review!.getCommit(b).sha;
    repo.write('c.txt', 'c\n');
    await controller.refresh();

    await controller.amend(['c.txt'], a);

    const model = controller.review!;
    const shaA = model.getCommit(a).sha!;
    expect(repo.git('show', '--name-only', '--format=', shaA).trim().split('\n')).toEqual(['a.txt', 'c.txt']);
    expect(model.getCommit(b).sha).not.toBe(newerBefore);
    expect(model.getCommit(b).status).toBe('committed');
    expect(model.filesOf(a).map((f) => f.path)).toEqual(['a.txt', 'c.txt']);
    expect(model.filesOf(null)).toEqual([]);
    expect(controller.amendTargets().map((c) => c.id)).toEqual([a, b]);
  });

  it('refuses commits that are not committed', async () => {
    const { a } = await planned();
    await expect(controller.amend(['b.txt'], a)).rejects.toThrow(/not committed yet/);
  });
});

describe('plans that split files', () => {
  it('splits files by line ranges from a plan, keeps the review of a part and checks the ranges', async () => {
    repo.write('a.txt', lines((i) => (i === 2 ? 'two' : i === 20 ? 'twenty' : i === 25 ? 'twenty-five' : null)));
    repo.write('b.txt', 'b2\n');
    await controller.startReview();
    const plan = {
      commits: [
        { message: 'A', files: [{ path: 'a.txt', lines: [[1, 3] as [number, number]] }, 'b.txt'] },
        { message: 'B', files: [{ path: 'a.txt', lines: [20] }] },
      ],
    };
    await controller.setPlan(plan, undefined);
    const model = controller.review!;
    const [a, b] = model.commitsInOrder().map((c) => c.id);
    // Line 25 is in neither: it waits in Unassigned.
    expect(model.pendingEntries('a.txt').map((f) => [f.commitId, f.part?.own])).toEqual([
      [a, 1],
      [b, 1],
      [null, 1],
    ]);

    // A commit lists a file once; without "lines" it takes the rest (lines 20 and 25), and is reviewed again.
    await expect(
      controller.setPlan({ commits: [plan.commits[0], { message: 'B', files: [{ path: 'a.txt', lines: [20] }, { path: 'a.txt', lines: [25] }] }] }),
    ).rejects.toThrow(/more than once/);
    await controller.setPlan({ commits: [plan.commits[0], { message: 'B', files: ['a.txt'] }] });
    expect(model.findFile('a.txt', b)).toMatchObject({ part: { own: 2, total: 3 }, status: 'todo' });
    // The same parts again keep their approval.
    await controller.setStatus([{ path: 'a.txt', commitId: b }], 'done');
    await controller.setPlan({ commits: [plan.commits[0], { message: 'B', files: ['a.txt'] }] });
    expect(model.findFile('a.txt', b)!.status).toBe('done');

    // Committing A commits only line 2.
    await controller.setStatus([{ path: 'a.txt', commitId: a }, { path: 'b.txt' }], 'done');
    await controller.commitCommits([a]);
    expect(repo.git('show', 'HEAD:a.txt')).toBe(lines((i) => (i === 2 ? 'two' : null)));

    await expect(controller.setPlan({ commits: [{ message: 'C', files: [{ path: 'a.txt', lines: [10] }] }] })).rejects.toThrow(/line 10 of "a.txt" have no changes/);
    await expect(
      controller.setPlan({
        commits: [
          { message: 'C', files: [{ path: 'a.txt', lines: [[19, 21]] }] },
          { message: 'D', files: [{ path: 'a.txt', lines: [20] }] },
        ],
      }),
    ).rejects.toThrow(/line 20 of "a.txt" in both commit #1 and #2/);
  });
});
