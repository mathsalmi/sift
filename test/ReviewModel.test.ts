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

describe('commit review status', () => {
  it('is to do with no approved file, in progress with some, approved with all', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts'] }] });
    const id = m.commitsInOrder()[0].id;

    m.setStatus(['a.ts'], 'in-progress');
    expect(m.commitReviewStatus(id)).toBe('todo');
    m.setStatus(['a.ts'], 'done');
    expect(m.commitReviewStatus(id)).toBe('in-progress');
    m.setStatus(['b.ts'], 'done');
    expect(m.commitReviewStatus(id)).toBe('approved');
    m.markCommitted(id, 'sha1');
    expect(m.commitReviewStatus(id)).toBe('committed');
  });

  it('steps to the previous and next file of the same commit without wrapping', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts', 'c.ts'] }] });

    expect(m.adjacentFile('b.ts', 1)?.path).toBe('c.ts');
    expect(m.adjacentFile('b.ts', -1)?.path).toBe('a.ts');
    expect(m.adjacentFile('c.ts', 1)).toBeNull();
    expect(m.adjacentFile('a.ts', -1)).toBeNull();
  });
});

describe('plan explanations', () => {
  it('rejects explanations on files outside the commit or without a line', () => {
    const m = model();
    expect(() =>
      m.applyPlan({ commits: [{ message: 'X', files: ['a.ts'], explanations: [{ path: 'b.ts', line: 1, body: 'x' }] }] }),
    ).toThrow(/not one of its files/);
    expect(() =>
      m.applyPlan({ commits: [{ message: 'X', files: ['a.ts'], explanations: [{ path: 'a.ts', line: 0, body: 'x' }] }] }),
    ).toThrow(/1-based/);
  });

  it('a new plan drops old explanations and moves comments to their file\'s new commit', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'One', files: ['a.ts', 'b.ts'] }] });
    m.setExplanation('a.ts', 0, 'x', 'Why', 'now');
    const comment = m.addThread({ kind: 'comment', path: 'b.ts', line: 0, lineText: 'y', body: 'Hm?', author: 'user' }, 'now');

    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'B', files: ['b.ts'] }] });

    expect(m.state.threads.map((t) => t.id)).toEqual([comment.id]);
    expect(m.getThread(comment.id).commitId).toBe(m.commitsInOrder()[1].id);
  });
});

describe('comment threads', () => {
  it('edits and deletes the user\'s own messages, never Claude\'s', () => {
    const m = model();
    const t = m.addThread({ kind: 'comment', path: 'a.ts', line: 0, lineText: 'x', body: 'First', author: 'user' }, 'now');
    m.reply(t.id, 'ai', 'Answer', false, 'now', 'Claude');
    m.reply(t.id, 'user', 'Second', false, 'now');

    m.editMessage(t.id, 2, 'Second, edited');
    expect(m.getThread(t.id).messages[2].body).toBe('Second, edited');
    expect(() => m.editMessage(t.id, 1, 'x')).toThrow(/own messages/);

    m.deleteMessage(t.id, 2);
    expect(m.getThread(t.id).messages.map((x) => x.body)).toEqual(['First', 'Answer']);

    const lone = m.addThread({ kind: 'comment', path: 'a.ts', line: 3, lineText: 'x', body: 'Only', author: 'user' }, 'now');
    m.deleteMessage(lone.id, 0);
    expect(() => m.getThread(lone.id)).toThrow(/Unknown thread/);
  });

  it('lists unresolved comments of files, ignoring explanations and resolved threads', () => {
    const m = model();
    const open = m.addThread({ kind: 'comment', path: 'a.ts', line: 0, lineText: 'x', body: 'Why?', author: 'user' }, 'now');
    const done = m.addThread({ kind: 'comment', path: 'a.ts', line: 1, lineText: 'y', body: 'Ok', author: 'user' }, 'now');
    m.setThreadResolved(done.id, true);
    m.setExplanation('a.ts', 2, 'z', 'Because', 'now');
    m.addThread({ kind: 'comment', path: 'b.ts', line: 0, lineText: 'x', body: 'Hm', author: 'user' }, 'now');

    expect(m.unresolvedComments(['a.ts']).map((t) => t.id)).toEqual([open.id]);
    expect(m.unresolvedComments(['c.ts'])).toEqual([]);
  });

  it('marks open comments as being answered, and back to open with the reason on failure', () => {
    const m = model();
    const one = m.addThread({ kind: 'comment', path: 'a.ts', line: 0, lineText: 'x', body: 'Why?', author: 'user' }, 'now');
    m.setExplanation('b.ts', 0, 'y', 'Because', 'now');

    expect(m.startAsking().map((t) => t.id)).toEqual([one.id]);
    expect(m.sentThreads().map((t) => t.id)).toEqual([one.id]);
    expect(() => m.startAsking()).toThrow(/no open comments/);

    m.failAsking(one.id, 'timeout');
    expect(m.getThread(one.id)).toMatchObject({ status: 'open', error: 'timeout' });

    m.reply(one.id, 'ai', 'Here is why.', false, 'now', 'GPT');
    expect(m.getThread(one.id)).toMatchObject({ status: 'answered', error: undefined });
    expect(m.getThread(one.id).messages[1]).toMatchObject({ author: 'ai', model: 'GPT' });
  });
});
