import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractJson } from './prompts';
import type { AiProvider, AiRequest } from './types';

export type ProviderKind = 'claude-code' | 'vscode-lm' | 'command';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/** The provider chosen in settings (sift.ai.*). */
export async function resolveProvider(): Promise<AiProvider> {
  const config = vscode.workspace.getConfiguration('sift.ai');
  const kind = config.get<ProviderKind>('provider', 'claude-code');
  if (kind === 'vscode-lm') {
    return languageModelProvider(config.get<string>('languageModel', ''));
  }
  if (kind === 'command') {
    const command = config.get<string>('command', '').trim();
    if (!command) {
      throw new Error('Set sift.ai.command, or run "Sift: Choose AI".');
    }
    return new CommandProvider(command);
  }
  return new ClaudeCodeProvider(findClaudeBinary(config.get<string>('claudeCodePath', '')), config.get<string>('claudeCodeModel', ''), {
    directories: config.get<string[]>('claudeCodeAdditionalDirectories', []),
    tools: config.get<string[]>('claudeCodeAllowedTools', []),
  });
}

/** A short label of the configured AI for menus and tooltips, without contacting it. */
export function providerLabel(): string {
  const config = vscode.workspace.getConfiguration('sift.ai');
  const kind = config.get<ProviderKind>('provider', 'claude-code');
  if (kind === 'vscode-lm') {
    return `VS Code model ${config.get<string>('languageModel', '') || '(first available)'}`;
  }
  if (kind === 'command') {
    return `Command: ${config.get<string>('command', '') || '(not set)'}`;
  }
  const model = config.get<string>('claudeCodeModel', '');
  return `Claude Code${model ? ` (${model})` : ''}`;
}

/** A few words naming the AI, for the status bar. */
export function providerShortLabel(): string {
  const config = vscode.workspace.getConfiguration('sift.ai');
  const kind = config.get<ProviderKind>('provider', 'claude-code');
  if (kind === 'vscode-lm') {
    return config.get<string>('languageModel', '') || 'VS Code model';
  }
  if (kind === 'command') {
    return 'Command line AI';
  }
  const model = config.get<string>('claudeCodeModel', '');
  return `Claude Code${model ? ` (${model})` : ''}`;
}

/** Quick pick of every AI Sift can use here; saves the choice in user settings. */
export async function chooseProvider(): Promise<boolean> {
  type Item = vscode.QuickPickItem & { apply?: () => Promise<void> };
  const config = vscode.workspace.getConfiguration('sift.ai');
  const set = async (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
  };

  const claudeBinary = findClaudeBinary(config.get<string>('claudeCodePath', ''));
  const items: Item[] = [{ label: 'Claude Code', kind: vscode.QuickPickItemKind.Separator }];
  for (const model of ['', 'opus', 'sonnet', 'haiku']) {
    items.push({
      label: `$(sparkle) Claude Code${model ? ` · ${model}` : ''}`,
      description: model ? '' : 'default model',
      detail: claudeBinary ?? '`claude` from your shell',
      apply: () => set({ provider: 'claude-code', claudeCodeModel: model }),
    });
  }

  const models = await vscode.lm.selectChatModels().then(
    (m) => m,
    () => [] as vscode.LanguageModelChat[],
  );
  items.push({ label: 'VS Code language models', kind: vscode.QuickPickItemKind.Separator });
  if (models.length === 0) {
    items.push({ label: 'No models available', description: 'Install an extension that provides models, e.g. GitHub Copilot Chat' });
  }
  for (const model of models) {
    items.push({
      label: `$(hubot) ${model.name}`,
      description: `${model.vendor} · ${model.family}`,
      apply: () => set({ provider: 'vscode-lm', languageModel: model.id }),
    });
  }

  items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(terminal) Command line tool…',
    description: 'Any CLI that reads a prompt on stdin and prints the answer',
    apply: async () => {
      const command = await vscode.window.showInputBox({
        prompt: 'Command that reads the prompt on stdin and prints the answer (run in your login shell, in the repo)',
        placeHolder: 'e.g. codex exec -   ·   gemini -p   ·   llm -m gpt-4o',
        value: config.get<string>('command', ''),
        ignoreFocusOut: true,
      });
      if (command?.trim()) {
        await set({ provider: 'command', command: command.trim() });
      }
    },
  });

  const pick = await vscode.window.showQuickPick(items, { placeHolder: `AI for Sift (now: ${providerLabel()})` });
  if (!pick?.apply) {
    return false;
  }
  await pick.apply();
  return true;
}

/** What Claude Code may use besides reading the repository. */
export interface ClaudeAccess {
  /** Folders outside the repository it may read (`--add-dir`). */
  directories: string[];
  /** Extra tools it may use without asking, e.g. "WebFetch" or "mcp__atlassian" (all tools of that MCP server). */
  tools: string[];
}

/** Claude Code as a one-shot command: read-only tools, structured JSON answer. Uses the user's own Claude login. */
export class ClaudeCodeProvider implements AiProvider {
  readonly name: string;

  constructor(
    /** Absolute path, or null to run `claude` from the login shell. */
    private readonly binary: string | null,
    private readonly model: string,
    private readonly access: ClaudeAccess = { directories: [], tools: [] },
  ) {
    this.name = model ? `Claude (${model})` : 'Claude';
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
    const args = claudeArgs(request.schema, this.model, this.access);
    const stdout = this.binary
      ? await runProcess(this.binary, args, request.cwd, request.prompt, signal)
      : await runInLoginShell(['claude', ...args].map(shellQuote).join(' '), request.cwd, request.prompt, signal);
    let result: { is_error?: boolean; result?: string; structured_output?: unknown };
    try {
      result = JSON.parse(stdout) as typeof result;
    } catch {
      throw new Error(`Claude Code answered something unexpected: ${stdout.slice(0, 200)}`);
    }
    if (result.is_error) {
      throw new Error(`Claude Code: ${result.result ?? 'unknown error'}`);
    }
    return result.structured_output ?? extractJson(result.result ?? '');
  }
}

export function claudeArgs(schema: unknown, model: string, access: ClaudeAccess = { directories: [], tools: [] }): string[] {
  const extra = access.tools.map((t) => t.trim()).filter(Boolean);
  const mcp = extra.filter((t) => t.startsWith('mcp__'));
  // Built-in tools by name, e.g. "WebFetch" or "Bash(git log *)" → Bash.
  const builtIn = extra.filter((t) => !t.startsWith('mcp__')).map((t) => t.replace(/\(.*$/, ''));
  const tools = [...new Set(['Read', 'Grep', 'Glob', ...builtIn])];
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    // Read-only by default: it can look around the repo, but code changes come back as edits that Sift applies.
    '--tools',
    tools.join(','),
    '--disable-slash-commands',
  ];
  if (mcp.length === 0) {
    // Keep the context small and fast when no MCP tool is wanted.
    args.push('--strict-mcp-config');
  }
  if (extra.length > 0) {
    // Nobody can answer a permission prompt in a one-shot run, so these are allowed up front.
    args.push(`--allowedTools=${extra.join(',')}`);
  }
  for (const dir of access.directories.map((d) => d.trim()).filter(Boolean)) {
    args.push(`--add-dir=${expandHome(dir)}`);
  }
  if (model) {
    args.push('--model', model);
  }
  return args;
}

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

/** Any chat model registered in VS Code (GitHub Copilot, or other extensions that provide models). */
async function languageModelProvider(id: string): Promise<AiProvider> {
  const models = await vscode.lm.selectChatModels(id ? { id } : {});
  const model = models[0];
  if (!model) {
    throw new Error(
      id ? `The language model "${id}" is not available. Run "Sift: Choose AI".` : 'No VS Code language model is available. Run "Sift: Choose AI".',
    );
  }
  return {
    name: model.name,
    async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
      const cancel = new vscode.CancellationTokenSource();
      signal.addEventListener('abort', () => cancel.cancel());
      try {
        const response = await model.sendRequest(
          [vscode.LanguageModelChatMessage.User(request.prompt)],
          { justification: 'Sift asks the model to plan commits and answer your review comments.' },
          cancel.token,
        );
        let text = '';
        for await (const chunk of response.text) {
          text += chunk;
        }
        return extractJson(text);
      } finally {
        cancel.dispose();
      }
    },
  };
}

/** A command line tool: prompt on stdin, answer (containing the JSON) on stdout. */
export class CommandProvider implements AiProvider {
  readonly name: string;

  constructor(private readonly command: string) {
    this.name = command.split(/\s+/)[0] ?? 'AI';
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
    return extractJson(await runInLoginShell(this.command, request.cwd, request.prompt, signal));
  }
}

/** The setting, else the binary bundled with the Claude Code VS Code extension, else null (use the shell's `claude`). */
export function findClaudeBinary(setting: string): string | null {
  if (setting.trim()) {
    return setting.trim();
  }
  const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (extension) {
    const binary = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(binary)) {
      return binary;
    }
  }
  return null;
}

function runInLoginShell(command: string, cwd: string, input: string, signal: AbortSignal): Promise<string> {
  if (process.platform === 'win32') {
    return runProcess('cmd.exe', ['/d', '/s', '/c', command], cwd, input, signal);
  }
  return runProcess(process.env.SHELL || '/bin/zsh', ['-lc', command], cwd, input, signal);
}

function runProcess(command: string, args: string[], cwd: string, input: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Cancelled.'));
      return;
    }
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error(`Could not run ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(new Error('Cancelled.'));
        return;
      }
      const stdout = Buffer.concat(out).toString('utf8');
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`${path.basename(command)} exited with code ${code}: ${(stderr || stdout).slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=@,]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
