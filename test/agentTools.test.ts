import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgentTools } from '../src/ai/agentTools';
import { ReviewController } from '../src/controller/ReviewController';
import { GitRunner } from '../src/git/GitRunner';
import { SnapshotService } from '../src/git/SnapshotService';
import { StateStore } from '../src/state/StateStore';
import { createRepo, type TempRepo } from './helpers';
import { registeredTools } from './vscode-mock';

interface Tool {
  invoke(options: { input: unknown }): Promise<{ content: Array<{ value: string }> }>;
}

let repo: TempRepo;
let controller: ReviewController;

async function call(name: string, input: unknown = {}): Promise<string> {
  const tool = registeredTools.get(name) as Tool;
  const result = await tool.invoke({ input });
  return result.content.map((p) => p.value).join('');
}

beforeEach(async () => {
  repo = createRepo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  const git = new GitRunner(repo.dir);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
  controller = new ReviewController(repo.dir, gitDir, git, snapshots, new StateStore(path.join(repo.dir, '.sift', 'state.json')), true);
  await controller.init();
  registerAgentTools(controller);
});

afterEach(() => repo.cleanup());

describe('agent tools', () => {
  it('are the tools package.json declares', () => {
    const declared = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).contributes.languageModelTools.map(
      (t: { name: string }) => t.name,
    );
    expect([...registeredTools.keys()].sort()).toEqual([...declared].sort());
  });

  it('let an agent plan commits, explain lines and answer comments', async () => {
    expect(await call('sift_getReview')).toMatch(/No Sift review/);

    repo.write('src/a.ts', 'a changed\n');
    repo.write('src/b.ts', 'b changed\n');
    expect(
      await call('sift_setPlan', { commits: [{ message: 'Change a', files: ['src/a.ts'] }, { message: 'Change b', files: ['src/b.ts'] }] }),
    ).toMatch(/2 commit\(s\), 0 file\(s\) left unassigned/);
    expect(await call('sift_explain', { path: 'src/a.ts', line: 1, body: 'Why a changed' })).toMatch(/Explanation added/);

    const [first] = controller.review!.commitsInOrder();
    await controller.startCommit(first.id);
    const thread = await controller.addComment('src/a.ts', 0, 'a changed', 'Use a capital A');
    const review = JSON.parse(await call('sift_getReview'));
    expect(review.commits.map((c: { message: string }) => c.message)).toEqual(['Change a', 'Change b']);
    expect(review.commentsToAnswer).toEqual([
      expect.objectContaining({ threadId: thread.id, path: 'src/a.ts', line: 1, messages: [{ author: 'developer', body: 'Use a capital A' }] }),
    ]);

    // The agent edits the file with its own tools, then answers: the edit gets its own version.
    repo.write('src/a.ts', 'A changed\n');
    expect(await call('sift_reply', { threadId: thread.id, body: 'Done.', resolve: true })).toMatch(/resolved/);
    expect(controller.review!.state.threads.find((t) => t.id === thread.id)).toMatchObject({ status: 'resolved' });
    expect(controller.review!.fileVersions(first.id, 'src/a.ts').length).toBe(2);
    expect(JSON.parse(await call('sift_getReview')).commentsToAnswer).toEqual([]);
  });
});
