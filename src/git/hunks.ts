import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { GitRunner } from './GitRunner';

/**
 * One block of changed lines of a file against HEAD (a zero-context hunk). Lines keep their
 * terminator ("\n", or none for a last line without one), so applying hunks rebuilds files exactly.
 */
export interface Hunk {
  /** Identifies the change by its content, so it keeps its id while other parts of the file change. */
  key: string;
  oldStart: number;
  oldLines: number;
  /** 1-based first line in the working tree (for a pure deletion: the line after which lines went). */
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
}

/**
 * Hunks of a file's changes against HEAD; empty for files git can't diff as text. A new file (not in
 * HEAD) gets one block per paragraph instead of a single hunk, so it can be split too.
 */
export async function fileHunks(git: GitRunner, filePath: string): Promise<Hunk[]> {
  const inHead = await git.exec(['cat-file', '-e', `HEAD:${filePath}`], { okCodes: [0, 1, 128] });
  if (inHead.exitCode !== 0) {
    const content = await fs.readFile(path.join(git.cwd, ...filePath.split('/'))).catch(() => null);
    return content && !content.subarray(0, 8000).includes(0) ? paragraphHunks(content.toString('utf8')) : [];
  }
  const diff = await git.run(['diff', '--no-color', '--no-renames', '--no-ext-diff', '-U0', 'HEAD', '--', `:(literal)${filePath}`]);
  return parseHunks(diff);
}

/**
 * The blocks of a new file: each paragraph with the blank lines after it (blank lines at the top
 * go with the first one). Shaped like hunks that add to an empty file.
 */
export function paragraphHunks(text: string): Hunk[] {
  const lines = splitLines(text);
  const blank = (line: string) => line.trim() === '';
  const hunks: Hunk[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const endsBlock = i === lines.length - 1 || (blank(lines[i]) && !blank(lines[i + 1]) && lines.slice(start, i).some((l) => !blank(l)));
    if (endsBlock) {
      hunks.push({ key: '', oldStart: 0, oldLines: 0, newStart: start + 1, newLines: i - start + 1, removed: [], added: lines.slice(start, i + 1) });
      start = i + 1;
    }
  }
  return withKeys(hunks);
}

/** The file's text in HEAD; null when HEAD doesn't have it. */
export async function headText(git: GitRunner, filePath: string): Promise<string | null> {
  const result = await git.exec(['show', `HEAD:${filePath}`], { okCodes: [0, 128] });
  return result.exitCode === 0 ? result.stdout : null;
}

/** Parses a zero-context unified diff of one file. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let last: string[] | null = null;
  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        key: '',
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        removed: [],
        added: [],
      };
      hunks.push(current);
      last = null;
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('-')) {
      current.removed.push(`${line.slice(1)}\n`);
      last = current.removed;
    } else if (line.startsWith('+')) {
      current.added.push(`${line.slice(1)}\n`);
      last = current.added;
    } else if (line.startsWith('\\') && last && last.length > 0) {
      // "\ No newline at end of file": the line before it has no terminator.
      last[last.length - 1] = last[last.length - 1].replace(/\n$/, '');
    }
  }
  return withKeys(hunks);
}

/** Keys hunks by their content; identical changes get a counter. */
function withKeys(hunks: Hunk[]): Hunk[] {
  const seen = new Map<string, number>();
  for (const hunk of hunks) {
    const base = createHash('sha1').update(hunk.removed.join('')).update('\0').update(hunk.added.join('')).digest('hex').slice(0, 12);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    hunk.key = n === 0 ? base : `${base}.${n}`;
  }
  return hunks;
}

/** Applies some of a file's hunks to its HEAD text. */
export function applyHunks(base: string, hunks: Hunk[]): string {
  const lines = splitLines(base);
  // Last first, so earlier positions stay valid (blocks of a new file all start at 0: by their new line).
  for (const hunk of [...hunks].sort((a, b) => b.oldStart - a.oldStart || b.newStart - a.newStart)) {
    // With no old lines, oldStart is the line after which the new lines go.
    const at = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    lines.splice(at, hunk.oldLines, ...hunk.added);
  }
  return lines.join('');
}

/** Whether a hunk touches a 1-based working-tree line range. */
export function hunkTouches(hunk: Hunk, fromLine: number, toLine: number): boolean {
  // A deletion sits at the line above it; at the top of the file, at line 1.
  const start = hunk.newLines === 0 ? Math.max(hunk.newStart, 1) : hunk.newStart;
  const end = hunk.newLines === 0 ? start : hunk.newStart + hunk.newLines - 1;
  return start <= toLine && Math.max(end, start) >= fromLine;
}

/** "Lines 12–18", for pickers. */
export function hunkLabel(hunk: Hunk): string {
  if (hunk.newLines === 0) {
    return `Deleted after line ${hunk.newStart}`;
  }
  const end = hunk.newStart + hunk.newLines - 1;
  return end === hunk.newStart ? `Line ${hunk.newStart}` : `Lines ${hunk.newStart}–${end}`;
}

/** Content id of a set of hunks: an approval of part of a file holds while its hunks stay the same. */
export function hunkSignature(keys: string[]): string {
  return `hunks:${createHash('sha1').update([...keys].sort().join(',')).digest('hex').slice(0, 16)}`;
}

function splitLines(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === '' ? [] : lines;
}
