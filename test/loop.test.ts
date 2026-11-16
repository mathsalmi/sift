import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReviewController } from '../src/controller/ReviewController';
import { GitRunner } from '../src/git/GitRunner';
import { SnapshotService } from '../src/git/SnapshotService';
import { startMcpServer, type McpHttpServer } from '../src/mcp/server';
import { buildTools, type ToolDef } from '../src/mcp/tools';
import { StateStore } from '../src/state/StateStore';
import { createRepo, type TempRepo } from './helpers';

let repo: TempRepo;
let controller: ReviewController;
let tools: ToolDef[];
const notices: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  return tool.handler(args, {});
}

beforeEach(async () => {
  notices.length = 0;
  repo = createRepo({ 'src/a.ts': 'const a = 1;\nexport default a;\n', 'src/b.ts': 'b\n' });
  const git = new GitRunner(repo.dir);
  const gitDir = (await git.run(['rev-parse', '--absolute-git-dir'])).trim();
  const snapshots = await SnapshotService.create(git, 5 * 1024 * 1024);
  controller = new ReviewController(
    repo.dir,
    gitDir,
    git,
    snapshots,
    new StateStore(path.join(repo.dir, '.sift', 'state.json')),
    true,
  );
  await controller.init();
  tools = buildTools(controller, { notify: (m) => notices.push(m) });

  repo.write('src/a.ts', 'const a = 2;\nexport default a;\n');
  repo.write('src/b.ts', 'b changed\n');
  await controller.startReview();
});

afterEach(() => {
  controller.dispose();
  repo.cleanup();
});

describe('feedback loop through the tools', () => {
  it('plans, explains, waits, receives feedback, fixes, and gets approved', async () => {
    expect((await call('review_get_status')).next).toMatch(/review_set_plan/);

    await expect(
      call('review_set_plan', { commits: [{ message: 'Only a', files: ['src/a.ts'] }] }),
    ).rejects.toThrow(/leaves out 1 changed file/);

    await call('review_set_plan', {
      commits: [
        { message: 'Bump a', intent: 'a is 2 now', files: ['src/a.ts'] },
        { message: 'Change b', files: ['src/b.ts'] },
      ],
    });
    const status = await call('review_get_status');
    expect(status.next).toBe('Call review_start_commit with commitId "c_01".');

    const started = await call('review_start_commit', { commitId: 'c_01' });
    expect(started.commit).toMatchObject({ id: 'c_01', version: 0 });

    const explained = await call('review_explain', { path: 'src/a.ts', line: 1, body: 'Changed the value.' });
    const explanation = controller.review!.getThread(explained.threadId);
    expect(explanation).toMatchObject({ kind: 'explanation', line: 0, lineText: 'const a = 2;' });

    // Claude waits; the user comments and clicks Send to Claude.
    expect(controller.claudeIsWaiting).toBe(false);
    const waiting = call('review_wait_for_feedback', { timeoutSec: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(controller.claudeIsWaiting).toBe(true);
    await controller.addComment('src/a.ts', 0, 'const a = 2;', 'Use 3 instead.');
    await controller.sendToClaude();
    const feedback = await waiting;
    expect(controller.claudeIsWaiting).toBe(false);
    expect(feedback.event).toBe('feedback');
    expect(feedback.threads).toHaveLength(1);
    expect(feedback.threads[0]).toMatchObject({ path: 'src/a.ts', line: 1, messages: [{ author: 'user', body: 'Use 3 instead.' }] });
    expect(controller.review!.state.session.turn).toBe('claude');

    // Claude fixes, replies, marks ready.
    repo.write('src/a.ts', 'const a = 3;\nexport default a;\n');
    await call('review_reply', { threadId: feedback.threads[0].threadId, body: 'Now 3.' });
    const ready = await call('review_mark_ready', { summary: 'Set a to 3' });
    expect(ready).toMatchObject({ version: 1, changed: true });
    expect(notices).toEqual(['Set a to 3']);
    expect(controller.review!.state.session.turn).toBe('user');
    expect(controller.review!.getThread(feedback.threads[0].threadId).status).toBe('answered');

    // Nothing pending → wait times out with "none".
    expect((await call('review_wait_for_feedback', { timeoutSec: 1 })).event).toBe('none');

    // The user approves.
    await controller.setStatus(['src/a.ts'], 'done');
    const approvedWait = call('review_wait_for_feedback', { timeoutSec: 5 });
    await controller.approveCurrent();
    const approved = await approvedWait;
    expect(approved).toMatchObject({ event: 'approved', commitId: 'c_01', nextCommitId: 'c_02' });

    // Approval stays pending until acknowledged.
    expect((await call('review_get_feedback')).event).toBe('approved');
    const done = await call('review_commit_done');
    expect(done).toMatchObject({ done: false, commit: { id: 'c_02', version: 0 } });
    expect((await call('review_get_feedback')).event).toBe('none');
    expect(repo.git('show', 'HEAD:src/a.ts')).toBe('const a = 3;\nexport default a;\n');

    await expect(call('review_commit_done')).rejects.toThrow(/not approved/);
  });

  it('a user reply reopens a thread and turns an explanation into a comment', async () => {
    await call('review_set_plan', { commits: [{ message: 'All', files: ['src/a.ts', 'src/b.ts'] }] });
    await call('review_start_commit', { commitId: 'c_01' });
    const { threadId } = await call('review_explain', { path: 'src/a.ts', line: 1, body: 'Why: X' });

    await controller.replyAsUser(threadId, 'Not convinced, revert it.');

    expect(controller.review!.getThread(threadId)).toMatchObject({ kind: 'comment', status: 'open' });
    expect(await controller.sendToClaude()).toBe(1);
  });

  it('refuses to send when there are no open comments', async () => {
    await call('review_set_plan', { commits: [{ message: 'All', files: ['src/a.ts', 'src/b.ts'] }] });
    await call('review_start_commit', { commitId: 'c_01' });

    await expect(controller.sendToClaude()).rejects.toThrow(/no open comments/);
  });
});

describe('MCP over HTTP', () => {
  let server: McpHttpServer;

  afterEach(async () => {
    await server?.close();
  });

  it('serves the tools to a real MCP client and rejects bad tokens', async () => {
    server = await startMcpServer(tools, 0, 'secret-token', '---\ndescription: x\n---\n\n# Sift loop\nDo it.\n');
    const url = new URL(`http://127.0.0.1:${server.port}/mcp`);

    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer secret-token' } } }),
    );
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('review_wait_for_feedback');

    const result = (await client.callTool({ name: 'review_get_status', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0].text).next).toMatch(/review_set_plan/);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['start']);
    const prompt = await client.getPrompt({ name: 'start' });
    expect(prompt.messages[0].content).toEqual({ type: 'text', text: '# Sift loop\nDo it.' });
    await client.close();

    const denied = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    expect(denied.status).toBe(401);
  });
});
