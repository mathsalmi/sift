import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { extractJson } from './prompts';
import { REPO_TOOLS, runRepoTool } from './repoTools';
import { aiSettings, updateAiSettings, type AiSettings, type ProviderKind } from './settings';
import type { AiProvider, AiRequest } from './types';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * A command line AI Sift knows: how to find it, how to run it once, read-only, and where its
 * answer is in what it prints.
 */
export interface CliPreset {
  kind: 'claude' | 'codex' | 'gemini';
  /** "Claude Code" */
  label: string;
  /** Author of its messages in comment threads, e.g. "Claude". */
  author: string;
  /** Executable name, looked up in the login shell. */
  binary: string;
  /** Suggested models besides the default one. */
  models: string[];
  /** Where to get it, when it isn't installed. */
  install: string;
  /** A copy bundled with a VS Code extension, used before the shell's. */
  bundled?: () => string | null;
  args(settings: AiSettings, schema: unknown): string[];
  parse(stdout: string): unknown;
}

export const CLI_PRESETS: CliPreset[] = [
  {
    kind: 'claude',
    label: 'Claude Code',
    author: 'Claude',
    binary: 'claude',
    models: ['opus', 'sonnet', 'haiku'],
    install: 'Install the Claude Code extension or CLI',
    bundled: bundledClaude,
    args: (s, schema) => claudeArgs(schema, s.model, { directories: s.directories, extraArguments: s.extraArguments }),
    parse: (stdout) => {
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
    },
  },
  {
    kind: 'codex',
    label: 'Codex',
    author: 'Codex',
    binary: 'codex',
    models: [],
    install: 'Install the Codex CLI: npm install -g @openai/codex',
    args: (s) => codexArgs(s.model, s.extraArguments),
    // Progress goes to stderr; stdout is the final message only.
    parse: (stdout) => extractJson(stdout),
  },
  {
    kind: 'gemini',
    label: 'Gemini CLI',
    author: 'Gemini',
    binary: 'gemini',
    models: ['pro', 'flash', 'flash-lite'],
    install: 'Install the Gemini CLI: npm install -g @google/gemini-cli',
    args: (s) => geminiArgs(s.model, s.directories, s.extraArguments),
    parse: (stdout) => {
      let result: { response?: string; error?: { message?: string } };
      try {
        result = JSON.parse(stdout) as typeof result;
      } catch {
        return extractJson(stdout);
      }
      if (result.error) {
        throw new Error(`Gemini CLI: ${result.error.message ?? 'unknown error'}`);
      }
      return extractJson(result.response ?? '');
    },
  },
];

export function cliPreset(kind: ProviderKind): CliPreset | undefined {
  return CLI_PRESETS.find((p) => p.kind === kind);
}

/** The provider chosen in settings (sift.ai.*). */
export async function resolveProvider(): Promise<AiProvider> {
  const settings = aiSettings();
  if (settings.provider === 'vscode') {
    return languageModelProvider(settings.model);
  }
  if (settings.provider === 'custom') {
    if (!settings.command) {
      throw new Error('Set sift.ai.command, or run "Sift: Choose AI…".');
    }
    return new CommandProvider(settings.command);
  }
  return new CliProvider(cliPreset(settings.provider) ?? CLI_PRESETS[0], settings);
}

/** The configured AI for tooltips and messages, without contacting it. */
export function providerLabel(): string {
  const s = aiSettings();
  if (s.provider === 'vscode') {
    return `VS Code model ${s.model || '(first available)'}`;
  }
  if (s.provider === 'custom') {
    return `Custom command: ${s.command || '(not set)'}`;
  }
  const preset = cliPreset(s.provider) ?? CLI_PRESETS[0];
  return `${preset.label}${s.model ? ` (${s.model})` : ''}`;
}

/** A few words naming the AI, for the status bar. */
export function providerShortLabel(): string {
  const s = aiSettings();
  if (s.provider === 'vscode') {
    return s.model || 'VS Code model';
  }
  if (s.provider === 'custom') {
    return s.command.split(/\s+/)[0] || 'Custom AI';
  }
  const preset = cliPreset(s.provider) ?? CLI_PRESETS[0];
  return `${preset.label}${s.model ? ` (${s.model})` : ''}`;
}

/** Quick pick of every AI Sift can use here; saves the choice in user settings. */
export async function chooseProvider(): Promise<boolean> {
  type Item = vscode.QuickPickItem & { apply?: () => Promise<boolean> };
  const settings = aiSettings();
  const [found, models] = await Promise.all([
    Promise.all(CLI_PRESETS.map((p) => locate(p, settings.provider === p.kind ? settings.command : ''))),
    vscode.lm.selectChatModels().then(
      (m) => m,
      () => [] as vscode.LanguageModelChat[],
    ),
  ]);

  const items: Item[] = [{ label: 'Command line AIs', kind: vscode.QuickPickItemKind.Separator }];
  CLI_PRESETS.forEach((preset, i) => {
    items.push({
      label: `$(terminal) ${preset.label}`,
      description: found[i] ? undefined : 'not found',
      detail: found[i] ?? preset.install,
      apply: async () => {
        const model = await pickModel(preset, settings.provider === preset.kind ? settings.model : '');
        if (model === undefined) {
          return false;
        }
        const command = settings.provider === preset.kind ? settings.command : '';
        await updateAiSettings({ provider: preset.kind, model, command });
        return true;
      },
    });
  });

  items.push({ label: 'Models in VS Code', kind: vscode.QuickPickItemKind.Separator });
  if (models.length === 0) {
    items.push({ label: 'No models available', description: 'Install an extension that provides models, e.g. GitHub Copilot Chat' });
  }
  for (const model of models) {
    items.push({
      label: `$(hubot) ${model.name}`,
      description: `${model.vendor} · ${model.family}`,
      apply: async () => {
        await updateAiSettings({ provider: 'vscode', model: model.id, command: '' });
        return true;
      },
    });
  }

  items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(gear) Custom command…',
    description: 'Any command line tool that reads a prompt on stdin and prints the answer',
    apply: async () => {
      const command = await vscode.window.showInputBox({
        prompt: 'Command that reads the prompt on stdin and prints the answer (run in your login shell, in the repo)',
        placeHolder: 'e.g. llm -m gpt-4o',
        value: settings.provider === 'custom' ? settings.command : '',
        ignoreFocusOut: true,
      });
      if (!command?.trim()) {
        return false;
      }
      await updateAiSettings({ provider: 'custom', model: '', command: command.trim() });
      return true;
    },
  });

  const pick = await vscode.window.showQuickPick(items, { placeHolder: `AI for Sift (now: ${providerLabel()})`, matchOnDetail: true });
  return pick?.apply ? pick.apply() : false;
}

/** The model for a command line AI: its default, a suggested one, or one typed in. Undefined when cancelled. */
async function pickModel(preset: CliPreset, current: string): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { model?: string };
  const items: Item[] = [
    { label: 'Default model', description: `${preset.label}'s own choice`, model: '' },
    ...preset.models.map((m) => ({ label: m, model: m })),
    { label: 'Other model…' },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: `Model for ${preset.label}${current ? ` (now: ${current})` : ''}` });
  if (!pick) {
    return undefined;
  }
  if (pick.model !== undefined) {
    return pick.model;
  }
  const typed = await vscode.window.showInputBox({ prompt: `Model name for ${preset.label}`, value: current, ignoreFocusOut: true });
  return typed?.trim() || undefined;
}

/** A command line AI run once per request, read-only, with the prompt on stdin. */
export class CliProvider implements AiProvider {
  readonly name: string;

  constructor(
    private readonly preset: CliPreset,
    private readonly settings: AiSettings,
  ) {
    this.name = settings.model ? `${preset.author} (${settings.model})` : preset.author;
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
    const args = this.preset.args(this.settings, request.schema);
    const binary = this.settings.command || this.preset.bundled?.() || null;
    const stdout = binary
      ? await runProcess(binary, args, request.cwd, request.prompt, signal)
      : await runInLoginShell([this.preset.binary, ...args].map(shellQuote).join(' '), request.cwd, request.prompt, signal);
    return this.preset.parse(stdout);
  }
}

/** Where a command line AI is: the configured path, a bundled copy, or the shell's. Null when not found. */
async function locate(preset: CliPreset, configured: string): Promise<string | null> {
  if (configured) {
    return configured;
  }
  const bundled = preset.bundled?.();
  if (bundled) {
    return bundled;
  }
  const lookup = process.platform === 'win32' ? `where ${preset.binary}` : `command -v ${preset.binary}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const out = await runInLoginShell(lookup, os.homedir(), '', abort.signal);
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a command line AI may use besides reading the repository. */
export interface CliAccess {
  /** Folders outside the repository it may read. */
  directories: string[];
  /** Extra options from sift.ai.extraArguments. */
  extraArguments: string[];
}

/** Tools named in --allowedTools / --allowed-tools among the extra arguments. */
function allowedTools(extra: string[]): string[] {
  const tools: string[] = [];
  extra.forEach((arg, i) => {
    const match = /^--allowed-?[tT]ools(?:=(.*))?$/.exec(arg);
    if (match) {
      const value = match[1] ?? extra[i + 1] ?? '';
      tools.push(...splitTools(value));
    }
  });
  return tools;
}

/** "WebFetch, Bash(git log *)" → ["WebFetch", "Bash(git log *)"]: commas and spaces split, except inside parentheses. */
function splitTools(value: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of value) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      tools.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  tools.push(current);
  return tools.filter(Boolean);
}

export function claudeArgs(schema: unknown, model: string, access: CliAccess = { directories: [], extraArguments: [] }): string[] {
  const extra = access.extraArguments;
  const allowed = allowedTools(extra);
  // Built-in tools by name, e.g. "WebFetch" or "Bash(git log *)" → Bash.
  const builtIn = allowed.filter((t) => !t.startsWith('mcp__')).map((t) => t.replace(/\(.*$/, ''));
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
  if (!allowed.some((t) => t.startsWith('mcp__')) && !extra.some((a) => a.startsWith('--mcp-config'))) {
    // Keep the context small and fast when no MCP tool is wanted.
    args.push('--strict-mcp-config');
  }
  for (const dir of access.directories) {
    args.push(`--add-dir=${expandHome(dir)}`);
  }
  if (model) {
    args.push('--model', model);
  }
  return [...args, ...extra];
}

/** `codex exec` in its read-only sandbox, prompt on stdin ("-"). */
export function codexArgs(model: string, extra: string[] = []): string[] {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'];
  if (model) {
    args.push('--model', model);
  }
  return [...args, ...extra, '-'];
}

/**
 * Gemini CLI headless: the prompt comes on stdin, `--prompt` only adds a line after it. Without a
 * terminal it uses no tool that needs approval, so it can read but not change files.
 */
export function geminiArgs(model: string, directories: string[] = [], extra: string[] = []): string[] {
  const args = ['--output-format', 'json'];
  if (model) {
    args.push('--model', model);
  }
  if (directories.length > 0) {
    args.push('--include-directories', directories.map(expandHome).join(','));
  }
  return [...args, ...extra, '--prompt', 'Answer as the instructions above say.'];
}

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

/** The claude binary bundled with the Claude Code VS Code extension, if installed. */
function bundledClaude(): string | null {
  const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
  if (extension) {
    const binary = path.join(extension.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(binary)) {
      return binary;
    }
  }
  return null;
}

/** Any chat model registered in VS Code (GitHub Copilot, or other extensions that provide models). */
async function languageModelProvider(id: string): Promise<AiProvider> {
  const models = await vscode.lm.selectChatModels(id ? { id } : {});
  const model = models[0];
  if (!model) {
    throw new Error(
      id ? `The language model "${id}" is not available. Run "Sift: Choose AI…".` : 'No VS Code language model is available. Run "Sift: Choose AI…".',
    );
  }
  return {
    name: model.name,
    async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
      const cancel = new vscode.CancellationTokenSource();
      signal.addEventListener('abort', () => cancel.cancel());
      try {
        return extractJson(await askWithRepoTools(model, request, cancel.token));
      } finally {
        cancel.dispose();
      }
    },
  };
}

/** Tool rounds before the model must answer: enough to look around, bounded so a request ends. */
const MAX_TOOL_ROUNDS = 12;
const JUSTIFICATION = 'Sift asks the model to plan commits and answer your review comments.';

/**
 * Asks a VS Code model, letting it read the repository with Sift's read-only tools first (read a
 * file, search, list files), like the command line AIs do. Returns the model's final text.
 */
async function askWithRepoTools(model: vscode.LanguageModelChat, request: AiRequest, token: vscode.CancellationToken): Promise<string> {
  const tools: vscode.LanguageModelChatTool[] = REPO_TOOLS.map((t) => ({ ...t }));
  const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];
  let useTools = true;
  for (let round = 0; ; round++) {
    // The last round offers no tools, so the model has to answer.
    const offer = useTools && round < MAX_TOOL_ROUNDS;
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, { justification: JUSTIFICATION, tools: offer ? tools : undefined }, token);
    } catch (error) {
      if (!offer || round > 0 || token.isCancellationRequested) {
        throw error;
      }
      // Some models don't take tools: ask again with the prompt alone.
      useTools = false;
      round--;
      continue;
    }
    let text = '';
    const calls: vscode.LanguageModelToolCallPart[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }
    if (calls.length === 0) {
      return text;
    }
    const results = await Promise.all(calls.map((call) => runRepoTool(request.cwd, call.name, call.input)));
    messages.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
    messages.push(
      vscode.LanguageModelChatMessage.User(
        calls.map((call, i) => new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(results[i])])),
      ),
    );
  }
}

/** A custom command: prompt on stdin, answer (containing the JSON) on stdout. */
export class CommandProvider implements AiProvider {
  readonly name: string;

  constructor(private readonly command: string) {
    this.name = command.split(/\s+/)[0] ?? 'AI';
  }

  async ask(request: AiRequest, signal: AbortSignal): Promise<unknown> {
    return extractJson(await runInLoginShell(this.command, request.cwd, request.prompt, signal));
  }
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
