import { describe, expect, it } from 'vitest';
import type { ReviewController } from '../src/controller/ReviewController';
import { ReviewModel } from '../src/core/ReviewModel';
import { PlanTree, type PlanNode } from '../src/ui/PlanTree';
import { ViewOptions } from '../src/ui/ViewOptions';

function setup() {
  const paths = ['src/a.ts', 'src/b.ts', 'c.ts'];
  const model = ReviewModel.create(
    's1',
    'head0',
    paths.map((path) => ({ path, changeType: 'modified' as const, adds: 1, dels: 1, binary: false })),
    '2026-11-19T00:00:00Z',
  );
  model.applyPlan({ commits: [{ message: 'All', files: paths }] });
  const commitId = model.commitsInOrder()[0].id;
  model.setStatus(['src/b.ts'], 'done');
  model.setStatus(['c.ts'], 'in-progress');
  const values = new Map<string, unknown>();
  const memento = {
    get: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  };
  const options = new ViewOptions(memento as never);
  const controller = { review: model, excluded: [], onDidChange: () => undefined } as unknown as ReviewController;
  return { tree: new PlanTree(controller, options), options, commit: { kind: 'commit', commitId } as PlanNode, commitId };
}

describe('PlanTree grouped by status', () => {
  it('splits a commit into To do / In progress / Approved, with folders inside each group', async () => {
    const { tree, options, commit, commitId } = setup();
    expect(tree.getChildren(commit).map((n) => n.kind)).toEqual(['file', 'file', 'file']);

    await options.setGroupByStatus(true);
    const groups = tree.getChildren(commit);
    expect(groups).toEqual([
      { kind: 'status', status: 'todo', commitId },
      { kind: 'status', status: 'in-progress', commitId },
      { kind: 'status', status: 'done', commitId },
    ]);
    expect(tree.getChildren(groups[2])).toEqual([{ kind: 'file', path: 'src/b.ts', commitId }]);

    await options.setAsTree(true);
    const [dir] = tree.getChildren(groups[0]);
    expect(dir).toMatchObject({ kind: 'dir', dir: 'src/', status: 'todo' });
    expect(tree.getChildren(dir)).toEqual([{ kind: 'file', path: 'src/a.ts', commitId }]);
    // Revealing a file walks up through its folder and its status group.
    expect(tree.getParent({ kind: 'file', path: 'src/a.ts', commitId })).toEqual(dir);
    expect(tree.getParent(dir)).toEqual(groups[0]);
    expect(tree.getParent(groups[0])).toEqual(commit);

    await options.setShowDone(false);
    expect(tree.getChildren(commit).map((n) => (n as { status: string }).status)).toEqual(['todo', 'in-progress']);
  });
});

describe('PlanTree visibility', () => {
  it('hides committed commits apart from approved files, and filters files by fuzzy path', async () => {
    const { tree, options, commit, commitId } = setup();
    const model = (tree as unknown as { controller: { review: ReviewModel } }).controller.review;
    model.setStatus(['src/a.ts', 'c.ts'], 'done');
    // Approved but not committed: hiding approved files keeps the commit listed.
    await options.setShowDone(false);
    expect(tree.getChildren()).toEqual([commit]);
    expect(tree.getChildren(commit)).toEqual([]);

    model.markCommitted(commitId, 'sha1');
    await options.setShowDone(true);
    expect(tree.getChildren()).toEqual([commit]);
    await options.setShowCommitted(false);
    expect(tree.getChildren()).toEqual([]);
    await options.setShowCommitted(true);

    await options.setFilter('sr b');
    expect(tree.getChildren(commit)).toEqual([{ kind: 'file', path: 'src/b.ts', commitId }]);
    await options.setFilter('zzz');
    expect(tree.getChildren()).toEqual([]);
  });
});
