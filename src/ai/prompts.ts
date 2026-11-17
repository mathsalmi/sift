import type { ReviewFile, ReviewThread } from '../core/types';

/** Diffs bigger than this are cut in the prompt; the total is capped too, so huge change sets still fit. */
const MAX_DIFF_CHARS_PER_FILE = 24_000;
const MAX_DIFF_CHARS_TOTAL = 400_000;
/** Files longer than this are shown around the commented line only. */
const MAX_FILE_LINES = 1500;
const WINDOW_LINES = 200;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    commits: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Imperative subject line (max 72 chars), optional body after a blank line.' },
          intent: { type: 'string', description: 'What this commit does and why, 1-2 sentences, for the reviewer.' },
          riskNotes: { type: 'array', items: { type: 'string' }, description: 'Spots that deserve careful review.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths, exactly as listed.' },
          explanations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: "One of this commit's files." },
                line: { type: 'integer', minimum: 1, description: 'Line number in the current file (the number shown in the diff).' },
                body: { type: 'string', description: 'Markdown, max 3 short bullets: what changed here and why.' },
              },
              required: ['path', 'line', 'body'],
            },
          },
        },
        required: ['message', 'intent', 'files', 'explanations'],
      },
    },
  },
  required: ['commits'],
} as const;

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Markdown reply shown in the thread. Short and direct.' },
    edits: {
      type: 'array',
      description: 'Code changes, only when the comment asks for a change. Empty for questions.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative path.' },
          find: {
            type: 'string',
            description: 'Exact text currently in the file, appearing exactly once (include a few surrounding lines). Empty string to create a new file.',
          },
          replace: { type: 'string', description: 'Text that replaces `find`.' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  required: ['reply', 'edits'],
} as const;

export interface PlanFile {
  file: ReviewFile;
  diff: string;
}

export function planPrompt(repoName: string, files: PlanFile[]): string {
  let budget = MAX_DIFF_CHARS_TOTAL;
  const list = files
    .map(({ file }) => `- ${file.path} (${file.changeType}${file.binary ? ', binary' : ''}, +${file.adds ?? '?'} -${file.dels ?? '?'})`)
    .join('\n');
  const diffs = files
    .map(({ file, diff }) => {
      if (file.binary || !diff) {
        return `### ${file.path}\n(binary or empty)`;
      }
      let numbered = numberDiff(diff);
      if (numbered.length > MAX_DIFF_CHARS_PER_FILE) {
        numbered = `${numbered.slice(0, MAX_DIFF_CHARS_PER_FILE)}\n… (diff cut; read the file if you need more)`;
      }
      if (budget <= 0) {
        return `### ${file.path}\n(diff left out to keep the prompt small; read the file if you need it)`;
      }
      budget -= numbered.length;
      return `### ${file.path}\n${numbered}`;
    })
    .join('\n\n');

  return `You help a developer turn their uncommitted changes in the "${repoName}" repository into a sequence of small, atomic git commits. They will review the commits one by one in their editor, reading your explanations next to the code.

Rules:
- Every file listed below goes into exactly one commit. Use the paths exactly as listed.
- Order the commits so each builds on the earlier ones (foundations first). Each commit should make sense on its own.
- message: imperative subject line (max 72 characters); add a body after a blank line only when it helps.
- intent: what the commit does and why, in 1-2 sentences.
- riskNotes: spots the reviewer should read carefully (can be empty).
- explanations: add a note on every line that carries intent or risk, saying what changed and why. Use the line numbers shown in the left column of the diffs (they are line numbers in the current file). Skip mechanical changes such as imports, renames or formatting. Max 3 short bullets per note.

Changed files:
${list}

Diffs (left column: line number in the current file; "-" lines are removed and have no number):

${diffs}

${jsonInstruction(PLAN_SCHEMA)}`;
}

export interface ThreadContext {
  thread: ReviewThread;
  /** Current content of the file, split in lines. */
  lines: string[];
  /** 0-based line the thread is anchored to now. */
  line: number;
  diff: string;
  commit: { message: string; intent: string } | null;
}

export function threadPrompt(repoName: string, context: ThreadContext): string {
  const { thread, lines, line, diff, commit } = context;
  const start = lines.length > MAX_FILE_LINES ? Math.max(0, line - WINDOW_LINES) : 0;
  const end = lines.length > MAX_FILE_LINES ? Math.min(lines.length, line + WINDOW_LINES) : lines.length;
  const width = String(end).length;
  const file = lines
    .slice(start, end)
    .map((text, i) => `${String(start + i + 1).padStart(width)}${start + i === line ? ' >' : '  '} ${text}`)
    .join('\n');
  const conversation = thread.messages
    .map((m) => `${m.author === 'user' ? 'Developer' : 'You'}: ${m.body}`)
    .join('\n\n');
  const commitText = commit ? `\nThe file belongs to the planned commit "${commit.message}"${commit.intent ? `: ${commit.intent}` : ''}.` : '';
  const numberedDiff = diff ? numberDiff(diff).slice(0, MAX_DIFF_CHARS_PER_FILE) : '(no diff)';

  return `You are reviewing code changes with a developer in the "${repoName}" repository, inside their editor. They wrote in a comment thread on line ${line + 1} of ${thread.path}.${commitText}

The developer may ask a question or give a direction:
- A question: answer it in "reply". Do not change code unless they ask for it ("edits": []).
- A direction: make the change with "edits", and say briefly in "reply" what you changed. If you disagree, say why instead.
Keep the reply short (a few sentences or 3 bullets). You may change other files when the direction needs it.
If you could not read something you needed (a folder outside the repository, an external tracker), name the exact folder or tool, so the developer can give you access.

Conversation in the thread (latest last):

${conversation}

Current ${thread.path}${start > 0 || end < lines.length ? ` (lines ${start + 1}-${end})` : ''}, the commented line is marked with ">":

${file}

Diff of ${thread.path} against the last commit (left column: line number in the current file):

${numberedDiff}

${jsonInstruction(ANSWER_SCHEMA)}`;
}

function jsonInstruction(schema: unknown): string {
  return `Answer with only a JSON object (no prose around it) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
}

/** Prefixes context and added lines of a unified diff with their line number in the new file. */
export function numberDiff(diff: string): string {
  const out: string[] = [];
  let next = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      out.push(line);
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      out.push(`${String(next).padStart(5)} ${line}`);
      next++;
    } else if (line.startsWith('-')) {
      out.push(`      ${line}`);
    } else if (line) {
      out.push(`      ${line}`);
    }
  }
  return out.join('\n');
}

/** Pulls the JSON object out of a model's text answer (bare, fenced, or with prose around it). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  throw new Error(`The AI did not answer with JSON: ${trimmed.slice(0, 200) || '(empty answer)'}`);
}
