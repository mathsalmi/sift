import { describe, expect, it } from 'vitest';
import { ReviewModel, type GitFacts } from '../src/core/ReviewModel';
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

  it('marks opened files in progress, but never done or unassigned ones', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'AB', files: ['a.ts', 'b.ts'] }] });
    m.setStatus(['b.ts'], 'done');

    expect(m.markOpened('a.ts')).toBe(true);
    expect(m.markOpened('b.ts')).toBe(false);
    expect(m.markOpened('c.ts')).toBe(false);
    expect(m.findFile('a.ts')?.status).toBe('in-progress');
    expect(m.findFile('c.ts')?.status).toBe('todo');
  });

  it('reviews files only inside a commit: unassigned ones have no status', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });

    m.setStatus(['a.ts', 'c.ts'], 'done');
    expect(m.findFile('a.ts')?.status).toBe('done');
    expect(m.findFile('c.ts')?.status).toBe('todo');

    // Moving an approved file out of its commit starts its review over.
    m.moveFiles(['a.ts'], null);
    expect(m.findFile('a.ts')).toMatchObject({ status: 'todo', approvedBlob: undefined });
  });

  it('ends the session when the last commit is committed and nothing is unassigned', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'Only', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.startCommit(id);
    m.setStatus(['a.ts'], 'done');

    expect(m.markCommitted(id, 'sha1')).toBeNull();
    expect(m.state.session).toMatchObject({ status: 'done', currentCommitId: null });
  });

  it('finds the next file to do after the current one, wrapping around', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'All', files: ['a.ts', 'b.ts', 'c.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['b.ts'], 'done');

    expect(m.nextTodo(id, 'a.ts')?.path).toBe('c.ts');
    expect(m.nextTodo(id, 'c.ts')?.path).toBe('a.ts');
  });

  it('finds the next file to do in the commits after this one, wrapping around', () => {
    const m = model();
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'B', files: ['b.ts'] }, { message: 'C', files: ['c.ts'] }] });
    const [a, b, c] = m.commitsInOrder().map((x) => x.id);
    m.setStatus(['b.ts'], 'done');

    expect(m.nextTodoInOtherCommit(a)?.path).toBe('c.ts');
    expect(m.nextTodoInOtherCommit(c)?.path).toBe('a.ts');
    expect(m.nextTodoInOtherCommit(null)?.path).toBe('a.ts');
    m.markCommitted(a, 'sha1');
    expect(m.nextTodoInOtherCommit(c)).toBeNull();
    expect(m.nextTodoInOtherCommit(b)?.path).toBe('c.ts');
  });
});

function facts(
  changes: FileChange[],
  more: { inHistory?: Record<string, string>; lastTouch?: Record<string, [string, number]>; blobs?: Record<string, string> } = {},
): GitFacts {
  return {
    changes,
    inHistory: new Map(Object.entries(more.inHistory ?? {})),
    lastTouch: new Map(Object.entries(more.lastTouch ?? {}).map(([p, [sha, age]]) => [p, { sha, age }])),
    blobs: new Map(Object.entries(more.blobs ?? {})),
  };
}

describe('sync', () => {
  it('adds new files, drops reverted ones and keeps committed history', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(id, 'sha1');

    m.sync(facts([change('c.ts', 'added')], { inHistory: { [id]: 'sha1' } }));

    expect(m.state.files.map((f) => f.path).sort()).toEqual(['a.ts', 'c.ts']);
    expect(m.findFile('a.ts')?.commitId).toBe(id);
  });

  it('gives a committed path a new pending entry when it changes again', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['a.ts'], 'done');
    m.markCommitted(id, 'sha1');

    m.sync(facts([change('a.ts')], { inHistory: { [id]: 'sha1' } }));

    expect(m.state.files.filter((f) => f.path === 'a.ts')).toHaveLength(2);
    expect(m.findFile('a.ts')).toMatchObject({ commitId: null, status: 'todo' });
  });

  it('derives committed status from git alone, as after loading a saved state', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'B', files: ['b.ts'] }] });
    const [a, b] = m.commitsInOrder();

    m.sync(facts([change('b.ts')], { inHistory: { [a.id]: 'sha1' } }));

    expect(m.getCommit(a.id)).toMatchObject({ status: 'committed', sha: 'sha1' });
    expect(m.getCommit(b.id).status).toBe('planned');
  });
});

describe('sync with work done outside Sift', () => {
  it('marks a planned commit committed when a commit since the start took its files', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'B', files: ['b.ts'] }] });
    const [a, b] = m.commitsInOrder();
    m.startCommit(a.id);

    const outcome = m.sync(facts([change('b.ts')], { lastTouch: { 'a.ts': ['x1', 0] } }));

    expect(outcome.committedOutside).toEqual(['A']);
    expect(outcome.refs).toEqual(new Map([[a.id, 'x1']]));
    expect(m.getCommit(a.id)).toMatchObject({ status: 'committed', sha: 'x1' });
    expect(m.findFile('a.ts')).toMatchObject({ commitId: a.id, status: 'done' });
    expect(m.state.session.currentCommitId).toBeNull();
    expect(m.getCommit(b.id).status).toBe('planned');
    expect(m.state.session.status).toBe('active');
  });

  it('links each commit to the newest commit that touched its files and ends the session when all are done', () => {
    const m = model(['a.ts', 'b.ts', 'c.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'BC', files: ['b.ts', 'c.ts'] }] });
    const [a, bc] = m.commitsInOrder();

    m.sync(facts([], { lastTouch: { 'a.ts': ['x2', 1], 'b.ts': ['x2', 1], 'c.ts': ['x1', 0] } }));

    expect(m.getCommit(a.id).sha).toBe('x2');
    expect(m.getCommit(bc.id).sha).toBe('x1');
    expect(m.state.session.status).toBe('done');
  });

  it('removes a planned commit whose files were reverted, but keeps commits that were empty already', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }, { message: 'B', files: ['b.ts'] }] });
    const empty = m.addCommit('Later');

    const outcome = m.sync(facts([change('b.ts')]));

    expect(outcome.removed).toEqual(['A']);
    expect(m.commitsInOrder().map((c) => c.message)).toEqual(['B', 'Later']);
    expect(m.getCommit(empty.id)).toBeDefined();
  });

  it('keeps a commit that still has some of its files', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'AB', files: ['a.ts', 'b.ts'] }] });

    const outcome = m.sync(facts([change('b.ts')], { lastTouch: { 'a.ts': ['x1', 0] } }));

    expect(outcome.committedOutside).toEqual([]);
    expect(m.filesOf(m.commitsInOrder()[0].id).map((f) => f.path)).toEqual(['b.ts']);
  });

  it('puts a commit back in the plan when it left HEAD\'s history and its files changed again', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    m.setStatus(['a.ts'], 'done', new Map([['a.ts', 'blob1']]));
    m.markCommitted(id, 'sha1');

    const outcome = m.sync(facts([change('a.ts')], { blobs: { 'a.ts': 'blob1' } }));

    expect(outcome.reopened).toEqual(['A']);
    expect(outcome.refs).toEqual(new Map([[id, null]]));
    expect(m.getCommit(id).status).toBe('planned');
    expect(m.state.files.filter((f) => f.path === 'a.ts')).toEqual([expect.objectContaining({ commitId: id, status: 'done' })]);
  });
});

describe('approvals tied to content', () => {
  it('keeps an approval while the content is the same and takes it back when it changes', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    m.setStatus(['a.ts'], 'done', new Map([['a.ts', 'blob1']]));

    expect(m.sync(facts([change('a.ts')], { blobs: { 'a.ts': 'blob1' } })).unapproved).toEqual([]);
    expect(m.findFile('a.ts')?.status).toBe('done');

    expect(m.sync(facts([change('a.ts')], { blobs: { 'a.ts': 'blob2' } })).unapproved).toEqual(['a.ts']);
    expect(m.findFile('a.ts')).toMatchObject({ status: 'in-progress', changedSinceApproval: true, approvedBlob: undefined });

    m.setStatus(['a.ts'], 'done', new Map([['a.ts', 'blob2']]));
    expect(m.findFile('a.ts')).toMatchObject({ status: 'done', approvedBlob: 'blob2', changedSinceApproval: undefined });
  });

  it('adopts the current content for approvals made before content was recorded', () => {
    const m = model(['a.ts']);
    m.applyPlan({ commits: [{ message: 'A', files: ['a.ts'] }] });
    m.setStatus(['a.ts'], 'done');

    m.sync(facts([change('a.ts')], { blobs: { 'a.ts': 'blob1' } }));

    expect(m.findFile('a.ts')).toMatchObject({ status: 'done', approvedBlob: 'blob1' });
  });

  it('clears the status of unassigned files saved by earlier versions', () => {
    const m = model(['a.ts']);
    m.state.files[0].status = 'done';

    m.sync(facts([change('a.ts')], { blobs: { 'a.ts': 'blob1' } }));

    expect(m.findFile('a.ts')?.status).toBe('todo');
  });
});

describe('file versions', () => {
  it('gives each file its own version, which only goes up when the file changed', () => {
    const m = model(['a.ts', 'b.ts']);
    m.applyPlan({ commits: [{ message: 'AB', files: ['a.ts', 'b.ts'] }] });
    const id = m.commitsInOrder()[0].id;
    const snapshot = (n: number, changed?: string[]) =>
      m.addIteration({ n, changed, commitId: id, treeSha: `t${n}`, commitSha: `c${n}`, ref: `r${n}`, author: 'ai', createdAt: '' });
    snapshot(0);
    snapshot(1, ['b.ts']);
    snapshot(2, ['b.ts', 'other.ts']);
    snapshot(3, ['a.ts']);

    expect(m.fileVersions(id, 'a.ts').map((i) => i.n)).toEqual([0, 3]);
    expect(m.fileVersions(id, 'b.ts').map((i) => i.n)).toEqual([0, 1, 2]);
    expect(m.fileVersion(m.findFile('a.ts')!)).toBe(1);
    expect(m.fileVersion(m.findFile('b.ts')!)).toBe(2);
    expect(m.fileVersionAt(id, 'a.ts', 2)).toBe(0);
    expect(m.fileVersionAt(id, 'b.ts', 3)).toBe(2);
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

describe('dependencies between commits', () => {
  function planned() {
    const m = model();
    m.applyPlan({
      commits: [
        { message: 'One', files: ['a.ts'] },
        { message: 'Two', files: ['b.ts'], dependsOn: [1] },
        { message: 'Three', files: ['c.ts'] },
      ],
    });
    return { m, ids: m.commitsInOrder().map((c) => c.id) };
  }

  it('takes dependsOn from the plan and only allows earlier commits', () => {
    const { m, ids } = planned();
    expect(m.getCommit(ids[1]).dependsOn).toEqual([ids[0]]);
    expect(() => m.applyPlan({ commits: [{ message: 'X', files: ['a.ts'], dependsOn: [1] }] })).toThrow(/only depend on commits before it/);
  });

  it('never moves a commit ahead of one it builds on', () => {
    const { m, ids } = planned();
    expect(() => m.moveCommit(ids[1], -1)).toThrow(/builds on "One"/);
    expect(() => m.moveCommit(ids[0], 1)).toThrow(/builds on "One"/);
    m.moveCommit(ids[2], -1);
    expect(m.commitsInOrder().map((c) => c.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(() => m.setDependencies(ids[0], [ids[2]])).toThrow(/only build on commits before it/);
  });

  it('commits approved commits whose dependencies come first, and a target with its dependencies', () => {
    const { m, ids } = planned();
    m.setStatus(['b.ts', 'c.ts'], 'done');
    // Two waits for One, which is not approved; Three stands alone.
    expect(m.commitBatch().map((c) => c.id)).toEqual([ids[2]]);
    expect(m.commitBatch(ids[1]).map((c) => c.id)).toEqual([ids[0], ids[1]]);
    expect(m.commitBlocker(ids[1])).toMatch(/not committed yet/);
    expect(m.commitBlocker(ids[1], new Set([ids[0]]))).toBeNull();
    m.setStatus(['a.ts'], 'done');
    expect(m.commitBatch().map((c) => c.id)).toEqual(ids);
  });

  it('moves a commit made ahead of planned ones up to the commits already made', () => {
    const { m, ids } = planned();
    m.markCommitted(ids[2], 'sha3');
    expect(m.commitsInOrder().map((c) => [c.id, c.order])).toEqual([
      [ids[2], 1],
      [ids[0], 2],
      [ids[1], 3],
    ]);
  });

  it('deleting a commit removes it from the commits that built on it', () => {
    const { m, ids } = planned();
    m.deleteCommit(ids[0]);
    expect(m.getCommit(ids[1]).dependsOn).toBeUndefined();
  });
});
