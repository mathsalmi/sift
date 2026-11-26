import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_PRESETS, claudeArgs, codexArgs, geminiArgs } from '../src/ai/providers';

describe('claudeArgs', () => {
  it('is read-only without MCP servers by default', () => {
    const args = claudeArgs({}, '');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args.some((a) => a.startsWith('--allowedTools'))).toBe(false);
  });

  it('adds folders and extra arguments, making allowed tools available and loading MCP servers only when one is named', () => {
    const args = claudeArgs({}, 'haiku', {
      directories: ['~/code', '/tmp/other'],
      extraArguments: ['--allowedTools=WebFetch,Bash(git log *),mcp__claude_ai_Atlassian'],
    });
    expect(args).not.toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,WebFetch,Bash');
    expect(args).toContain('--allowedTools=WebFetch,Bash(git log *),mcp__claude_ai_Atlassian');
    expect(args).toContain(`--add-dir=${path.join(os.homedir(), 'code')}`);
    expect(args).toContain('--add-dir=/tmp/other');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });
});

describe('codexArgs', () => {
  it('runs codex exec read-only with the prompt on stdin', () => {
    expect(codexArgs('')).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-']);
    expect(codexArgs('o3', ['--profile', 'work'])).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--model', 'o3', '--profile', 'work', '-',
    ]);
  });
});

describe('geminiArgs', () => {
  it('asks for JSON output, with the model and extra folders', () => {
    const args = geminiArgs('flash', ['~/code']);
    expect(args.slice(0, 2)).toEqual(['--output-format', 'json']);
    expect(args[args.indexOf('--model') + 1]).toBe('flash');
    expect(args[args.indexOf('--include-directories') + 1]).toBe(path.join(os.homedir(), 'code'));
    expect(args.at(-2)).toBe('--prompt');
  });
});

describe('answers', () => {
  const parse = (kind: string, stdout: string) => CLI_PRESETS.find((p) => p.kind === kind)!.parse(stdout);

  it('reads each tool\'s output format', () => {
    expect(parse('claude', JSON.stringify({ structured_output: { a: 1 } }))).toEqual({ a: 1 });
    expect(parse('codex', 'Here it is:\n{"a":1}')).toEqual({ a: 1 });
    expect(parse('gemini', JSON.stringify({ response: '```json\n{"a":1}\n```' }))).toEqual({ a: 1 });
    expect(() => parse('gemini', JSON.stringify({ error: { message: 'quota' } }))).toThrow(/quota/);
  });
});
