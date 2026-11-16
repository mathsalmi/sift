import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const MCP_SERVER_NAME = 'sift';
/** Names used before the rename to Sift; setup cleans them up. */
const LEGACY_SERVER_NAME = 'commit-review';
const LEGACY_COMMAND_FILE = 'commit-review.md';
/** Long enough for review_wait_for_feedback's maximum wait (600 s) plus margin. */
export const TOOL_TIMEOUT_MS = '660000';

export interface SetupStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SetupResult {
  ok: boolean;
  steps: SetupStep[];
  /** The `claude mcp add` command, for the manual fallback. */
  command: string;
}

/**
 * Connects Claude Code to this window's MCP server and installs the /sift command.
 * Uses the user's login shell so `claude` is found the same way as in their terminal.
 */
export async function setupClaudeCode(options: {
  root: string;
  port: number;
  token: string;
  slashCommandSource: string;
}): Promise<SetupResult> {
  const url = `http://127.0.0.1:${options.port}/mcp`;
  const addArgs = [
    'mcp',
    'add',
    '--transport',
    'http',
    '--scope',
    'local',
    MCP_SERVER_NAME,
    url,
    '--header',
    `Authorization: Bearer ${options.token}`,
  ];
  const command = ['claude', ...addArgs].map(shellQuote).join(' ');
  const steps: SetupStep[] = [];

  const version = await runInLoginShell(['claude', '--version'], options.root);
  if (!version.ok) {
    steps.push({
      label: 'Find the claude CLI',
      ok: false,
      detail: 'The "claude" command was not found in your login shell. Install Claude Code, or run the copied command yourself.',
    });
    return { ok: false, steps, command };
  }

  // Remove earlier registrations (old port, token or name); fine if there are none.
  await runInLoginShell(['claude', 'mcp', 'remove', '--scope', 'local', MCP_SERVER_NAME], options.root);
  await runInLoginShell(['claude', 'mcp', 'remove', '--scope', 'local', LEGACY_SERVER_NAME], options.root);
  const added = await runInLoginShell(['claude', ...addArgs], options.root);
  steps.push({ label: 'Register the sift MCP server for this repo', ok: added.ok, detail: added.ok ? undefined : added.output });
  if (!added.ok) {
    return { ok: false, steps, command };
  }

  steps.push(await installSlashCommand(options.slashCommandSource));
  steps.push(await ensureToolTimeout(path.join(os.homedir(), '.claude', 'settings.json')));

  return { ok: steps.every((s) => s.ok), steps, command };
}

export async function installSlashCommand(source: string): Promise<SetupStep> {
  const commandsDir = path.join(os.homedir(), '.claude', 'commands');
  const target = path.join(commandsDir, 'sift.md');
  try {
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.copyFile(source, target);
    await fs.rm(path.join(commandsDir, LEGACY_COMMAND_FILE), { force: true });
    return { label: `Install /sift (${target})`, ok: true };
  } catch (error) {
    return { label: 'Install /sift', ok: false, detail: (error as Error).message };
  }
}

/** Sets env.MCP_TOOL_TIMEOUT in Claude Code's user settings, which apply to the CLI and the VS Code panel. */
async function ensureToolTimeout(settingsPath: string): Promise<SetupStep> {
  const label = `Allow long waits (MCP_TOOL_TIMEOUT in ${settingsPath})`;
  const current = await fs.readFile(settingsPath, 'utf8').catch(() => null);
  let updated: string | null;
  try {
    updated = withToolTimeout(current);
  } catch (error) {
    return { label, ok: false, detail: `Could not parse the file: ${(error as Error).message}` };
  }
  if (updated === null) {
    return { label: `${label}: already set`, ok: true };
  }
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, updated, 'utf8');
  return { label, ok: true };
}

/**
 * Returns the settings JSON with env.MCP_TOOL_TIMEOUT added, or null when it is already set
 * (an existing value is never overwritten).
 */
export function withToolTimeout(settingsJson: string | null): string | null {
  const settings = settingsJson && settingsJson.trim() ? (JSON.parse(settingsJson) as Record<string, unknown>) : {};
  const env = (settings.env ?? {}) as Record<string, string>;
  if (env.MCP_TOOL_TIMEOUT) {
    return null;
  }
  settings.env = { ...env, MCP_TOOL_TIMEOUT: TOOL_TIMEOUT_MS };
  return JSON.stringify(settings, null, 2) + '\n';
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runInLoginShell(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const shell = process.env.SHELL || '/bin/zsh';
  const command = args.map(shellQuote).join(' ');
  return new Promise((resolve) => {
    execFile(shell, ['-lc', command], { cwd, timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
    });
  });
}
