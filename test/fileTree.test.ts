import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { claudeArgs } from '../src/ai/providers';
import { fileTreeChildren } from '../src/ui/fileTree';

const files = ['README.md', 'src/ui/a.ts', 'src/ui/b.ts', 'src/core/c.ts', 'test/deep/only/d.test.ts'].map((path) => ({ path }));

describe('fileTreeChildren', () => {
  it('lists folders first, compresses single-folder chains, then files', () => {
    expect(fileTreeChildren(files, '')).toEqual([
      { type: 'dir', dir: 'src/', label: 'src' },
      { type: 'dir', dir: 'test/deep/only/', label: 'test/deep/only' },
      { type: 'file', file: { path: 'README.md' } },
    ]);
    expect(fileTreeChildren(files, 'src/')).toEqual([
      { type: 'dir', dir: 'src/core/', label: 'core' },
      { type: 'dir', dir: 'src/ui/', label: 'ui' },
    ]);
    expect(fileTreeChildren(files, 'src/ui/').map((e) => (e.type === 'file' ? e.file.path : e.dir))).toEqual([
      'src/ui/a.ts',
      'src/ui/b.ts',
    ]);
  });
});

describe('claudeArgs', () => {
  it('is read-only without MCP servers by default', () => {
    const args = claudeArgs({}, '');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args.some((a) => a.startsWith('--allowedTools'))).toBe(false);
  });

  it('adds folders and pre-allowed tools, loading MCP servers only when one is named', () => {
    const args = claudeArgs({}, 'haiku', {
      directories: ['~/code', '/tmp/other'],
      tools: ['WebFetch', 'Bash(git log *)', 'mcp__claude_ai_Atlassian'],
    });
    expect(args).not.toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,WebFetch,Bash');
    expect(args).toContain('--allowedTools=WebFetch,Bash(git log *),mcp__claude_ai_Atlassian');
    expect(args).toContain(`--add-dir=${os.homedir()}/code`);
    expect(args).toContain('--add-dir=/tmp/other');
  });
});
