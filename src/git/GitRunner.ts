import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Exit codes that count as success. Default: [0]. */
  okCodes?: number[];
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * Runs git commands in one repository, one at a time.
 * Calls are queued so snapshot, staging and diff commands never race on the index.
 */
export class GitRunner {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly cwd: string) {}

  async run(args: string[], options: RunOptions = {}): Promise<string> {
    const result = await this.exec(args, options);
    return result.stdout;
  }

  exec(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const task = () => this.spawn(args, options);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private spawn(args: string[], options: RunOptions): Promise<RunResult> {
    const okCodes = options.okCodes ?? [0];

    return new Promise<RunResult>((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        {
          cwd: this.cwd,
          env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...options.env },
          maxBuffer: 512 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const exitCode = exitCodeOf(error);
          if (!okCodes.includes(exitCode)) {
            const detail = stderr.trim() || stdout.trim() || String(error?.message ?? '');
            reject(new GitError(`git ${args.join(' ')} failed: ${detail}`, args, exitCode, stderr));
            return;
          }
          resolve({ stdout, exitCode });
        },
      );

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }
}

function exitCodeOf(error: unknown): number {
  if (!error) {
    return 0;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') {
    return code;
  }
  return -1;
}
