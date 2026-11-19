import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { GitRunner } from '../git/GitRunner';

/**
 * Read-only tools Sift gives to VS Code models, so they can look around the repository the way the
 * command line AIs do: read a file, search the code, list files. Everything stays inside the repository.
 */
export interface RepoTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const REPO_TOOLS: RepoTool[] = [
  {
    name: 'read_file',
    description:
      'Read a file of the repository, with line numbers. Use startLine/endLine for a part of a long file. Shows the working tree, including uncommitted changes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        startLine: { type: 'number', description: 'First line, 1-based.' },
        endLine: { type: 'number', description: 'Last line, inclusive.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description:
      'Search the repository for a regular expression (git grep, extended syntax), e.g. a function name to find where it is defined or used. Returns path:line:text.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression.' },
        path: { type: 'string', description: 'Only search under this folder or file, relative to the root.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list_files',
    description: 'List the files of the repository (tracked and new, without ignored ones), optionally under a folder.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder relative to the repository root.' } },
    },
  },
];

const MAX_LINES = 1500;
const MAX_RESULTS = 200;
const MAX_FILES = 500;

/** Runs a tool and returns its text result; errors come back as text so the model can correct itself. */
export async function runRepoTool(root: string, name: string, input: unknown): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    if (name === 'read_file') {
      return await readFile(root, String(args.path ?? ''), num(args.startLine), num(args.endLine));
    }
    if (name === 'search') {
      return await search(root, String(args.pattern ?? ''), optional(args.path));
    }
    if (name === 'list_files') {
      return await listFiles(root, optional(args.path));
    }
    return `Unknown tool "${name}".`;
  } catch (error) {
    return `Error: ${(error as Error).message}`;
  }
}

/** A repository-relative path, refused when it leaves the repository or points into .git. */
function inside(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === '.git') {
    throw new Error(`${relative} is outside the repository.`);
  }
  return rel.split(path.sep).join('/');
}

async function readFile(root: string, relative: string, start?: number, end?: number): Promise<string> {
  const rel = inside(root, relative);
  const text = await fs.readFile(path.join(root, rel), 'utf8');
  if (text.includes('\0')) {
    return `${rel} is a binary file.`;
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const from = Math.max(1, start ?? 1);
  const to = Math.min(lines.length, end ?? lines.length, from + MAX_LINES - 1);
  const shown = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${line}`);
  const more = to < lines.length ? `\n… ${lines.length - to} more line(s); read on with startLine=${to + 1}.` : '';
  return `${rel} (${lines.length} lines)\n${shown.join('\n')}${more}`;
}

async function search(root: string, pattern: string, under?: string): Promise<string> {
  if (!pattern) {
    throw new Error('pattern is empty.');
  }
  const args = ['grep', '-n', '-I', '-E', '--untracked', '-e', pattern];
  if (under) {
    args.push('--', inside(root, under));
  }
  const result = await new GitRunner(root).exec(args, { okCodes: [0, 1] });
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return 'No matches.';
  }
  const more = lines.length > MAX_RESULTS ? `\n… ${lines.length - MAX_RESULTS} more match(es); narrow the pattern or the path.` : '';
  return lines.slice(0, MAX_RESULTS).join('\n') + more;
}

async function listFiles(root: string, under?: string): Promise<string> {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard'];
  if (under) {
    args.push('--', inside(root, under));
  }
  const files = [...new Set((await new GitRunner(root).run(args)).split('\n').filter(Boolean))];
  if (files.length === 0) {
    return 'No files.';
  }
  const more = files.length > MAX_FILES ? `\n… ${files.length - MAX_FILES} more file(s); list a folder.` : '';
  return files.slice(0, MAX_FILES).join('\n') + more;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim() !== '.' ? value.trim() : undefined;
}
