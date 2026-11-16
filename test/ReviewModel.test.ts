import { describe, expect, it } from 'vitest';
import { ReviewModel } from '../src/core/ReviewModel';
import type { FileChange } from '../src/git/changes';

const change = (path: string, changeType: FileChange['changeType'] = 'modified'): FileChange => ({
  path,
  changeType,
  adds: 1,
  dels: 1,
  binary: false,
});

function model(paths = ['a.ts', 'b.ts', 'c.ts']): ReviewModel {
  return ReviewModel.create('s1', 'head0', paths.map((p) => change(p)), '2026-11-14T00:00:00Z');
}

describe('applyPlan', () => {
  it('assigns files to commits in order and leaves the rest unassigned', () => {
    const m = model();

    const result = m.applyPlan({
      commits: [
        { message: 'First', files: ['b.ts'] },
        { message: 'Second', intent: 'why', files: ['a.ts'] },
      ],
    });

    expect(result.unassigned).toBe(1);
    expect(m.commitsInOrder().map((c) => c.message)).toEqual(['First', 'Second']);
    expect(m.filesOf(m.commitsInOrder()[0].id).map((f) => f.path)).toEqual(['b.ts']);
    expect(m.filesOf(null).map((f) => f.path)).toEqual(['c.ts']);
  });

  it('rejects unknown and duplicate paths without changing anything', () => {
    const m = model();

    expect(() => m.applyPlan({ commits: [{ message: 'X', files: ['nope.ts'] }] })).toThrow(/not a changed file/);
    expect(() =>
      m.applyPlan({ commits: [{ message: 'X', files: ['a.ts'] }, { message: 'Y', files: ['a.ts'] }] }),
    ).toThrow(/more than once/);
    expect(m.state.commits).toEqual([]);
  });

  it('keeps committed commits when a new plan is loaded', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'Done one', files: ['a.ts'] }] });
    const first = m.commitsInOrder()[0];
    m.startCommit(first.id);
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(first.id, 'sha1');

    m.applyPlan({ commits: [{ message: 'Rest', files: ['b.ts', 'c.ts'] }] });

    expect(m.commitsInOrder().map((c) => [c.message, c.status])).toEqual([
      ['Done one', 'committed'],
      ['Rest', 'planned'],
    ]);
  });
});

describe('review loop', () => {
  it('blocks approval until every file is done', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts'] }] });
    const id = m.commitsInOrder()[0].id;

    m.setStatus(['a.ts'], 'done');
    expect(m.approvalBlocker(id)).toMatch(/1 file/);

    m.setStatus(['b.ts'], 'done');
    expect(m.approvalBlocker(id)).toBeNull();
  });

  it('moves a done file back to in progress when a new round changes it', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts'] }] });
    m.setStatus(['a.ts', 'b.ts'], 'done');

    const reset = m.applyRoundChanges(['a.ts'], 2);

    expect(reset).toEqual(['a.ts']);
    expect(m.findFile('a.ts')).toMatchObject({ status: 'in-progress', changedInIteration: 2 });
    expect(m.findFile('b.ts')?.status).toBe('done');
  });

  it('marks opened files in progress, but never done ones', () => {
    const m = model();
    m.setStatus(['b.ts'], 'done');

    expect(m.markOpened('a.ts')).toBe(true);
    expect(m.markOpened('b.ts')).toBe(false);
    expect(m.findFile('a.ts')?.status).toBe('in-progress');
  });

  it('ends the session when the last commit is committed and nothing is unassigned', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'Only', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.startCommit(id);
    m.setStatus(['a.ts'], 'done');

    expect(m.markCommitted(id, 'sha1')).toBeNull();
    expect(m.state.session).toMatchObject({ status: 'done', currentCommitId: null, lastHead: 'sha1' });
  });

  it('finds the next file to do after the current one, wrapping around', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts', 'c.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['b.ts'], 'done');

    expect(m.nextTodo(id, 'a.ts')?.path).toBe('c.ts');
    expect(m.nextTodo(id, 'c.ts')?.path).toBe('a.ts');
  });
});

describe('syncChanges', () => {
  it('adds new files, drops reverted ones and keeps committed history', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(id, 'sha1');

    m.syncChanges([change('c.ts', 'added')]);

    expect(m.state.files.map((f) => f.path).sort()).toEqual(['a.ts', 'c.ts']);
    expect(m.findFile('a.ts')?.commitId).toBe(id);
  });

  it('gives a committed path a new pending entry when it changes again', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(id, 'sha1');

    m.syncChanges([change('a.ts')]);

    expect(m.state.files.filter((f) => f.path === 'a.ts')).toHaveLength(2);
    expect(m.findFile('a.ts')).toMatchObject({ commitId: null, status: 'todo' });
  });
});

describe('commit editing', () => {
  it('reorders planned commits but never moves past a committed one', () => {
    const m = model();
    m.applyPlan({
      commits: [
        { message: 'One', files: ['a.ts'] },
        { message: 'Two', files: ['b.ts'] },
        { message: 'Three', files: ['c.ts'] },
      ],
    });
    const [one, two, three] = m.commitsInOrder();
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(one.id, 'sha1');

    m.moveCommit(three.id, -1);
    m.moveCommit(three.id, -1);

    expect(m.commitsInOrder().map((c) => c.id)).toEqual([one.id, three.id, two.id]);
  });

  it('deleting a commit unassigns its files', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'One', files: ['a.ts', 'b.ts'] }] });

    m.deleteCommit(m.commitsInOrder()[0].id);

    expect(m.filesOf(null)).toHaveLength(3);
  });
});
