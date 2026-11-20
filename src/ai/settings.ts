import * as vscode from 'vscode';

/** Command line AIs Sift knows how to run, VS Code's own models, or any other command. */
export type ProviderKind = 'claude' | 'codex' | 'gemini' | 'vscode' | 'custom';

/** The sift.ai.* settings, the same for every provider. */
export interface AiSettings {
  provider: ProviderKind;
  /** Model name or id; empty for the provider's default. */
  model: string;
  /** For `custom`: the whole command. For a command line AI: where it is installed; empty to find it. */
  command: string;
  /** Folders outside the repository the AI may read. */
  directories: string[];
  /** Extra options for a command line AI, appended to the ones Sift passes. */
  extraArguments: string[];
}

const KINDS: ProviderKind[] = ['claude', 'codex', 'gemini', 'vscode', 'custom'];

export function aiSettings(): AiSettings {
  const config = vscode.workspace.getConfiguration('sift.ai');
  const provider = config.get<string>('provider', 'claude');
  return {
    provider: KINDS.includes(provider as ProviderKind) ? (provider as ProviderKind) : 'claude',
    model: config.get<string>('model', '').trim(),
    command: config.get<string>('command', '').trim(),
    directories: config.get<string[]>('additionalDirectories', []).map((d) => d.trim()).filter(Boolean),
    extraArguments: config.get<string[]>('extraArguments', []).map((a) => a.trim()).filter(Boolean),
  };
}

/** Saves settings in the user's settings, where "Choose AI" keeps them. */
export async function updateAiSettings(values: Partial<Pick<AiSettings, 'provider' | 'model' | 'command'>>): Promise<void> {
  const config = vscode.workspace.getConfiguration('sift.ai');
  for (const [key, value] of Object.entries(values)) {
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

/** Settings before they were made the same for every provider: old name → new name and value. */
const OLD_PROVIDERS: Record<string, ProviderKind> = { 'claude-code': 'claude', 'vscode-lm': 'vscode', command: 'custom' };

/**
 * Moves settings saved by earlier versions (sift.ai.claudeCodeModel, sift.ai.languageModel, …) to the
 * generic ones, in every scope they were set in, then removes the old ones.
 */
export async function migrateAiSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration('sift.ai');
  const scopes = [
    [vscode.ConfigurationTarget.Global, 'globalValue'],
    [vscode.ConfigurationTarget.Workspace, 'workspaceValue'],
  ] as const;
  for (const [target, field] of scopes) {
    const old = <T>(key: string): T | undefined => config.inspect<T>(key)?.[field];
    const provider = old<string>('provider');
    const updates: Record<string, unknown> = {};
    if (provider && OLD_PROVIDERS[provider]) {
      updates.provider = OLD_PROVIDERS[provider];
    }
    const kind = (updates.provider as ProviderKind | undefined) ?? (provider as ProviderKind | undefined) ?? 'claude';
    const model = kind === 'vscode' ? old<string>('languageModel') : old<string>('claudeCodeModel');
    if (model) {
      updates.model = model;
    }
    const path = old<string>('claudeCodePath');
    if (path && kind === 'claude' && !old<string>('command')) {
      updates.command = path;
    }
    const dirs = old<string[]>('claudeCodeAdditionalDirectories');
    if (dirs?.length) {
      updates.additionalDirectories = dirs;
    }
    const tools = old<string[]>('claudeCodeAllowedTools');
    if (tools?.length) {
      updates.extraArguments = [`--allowedTools=${tools.join(',')}`];
    }
    const oldKeys = ['claudeCodeModel', 'languageModel', 'claudeCodePath', 'claudeCodeAdditionalDirectories', 'claudeCodeAllowedTools'];
    if (Object.keys(updates).length === 0 && !oldKeys.some((key) => old(key) !== undefined)) {
      continue;
    }
    for (const [key, value] of Object.entries(updates)) {
      await config.update(key, value, target);
    }
    for (const key of oldKeys) {
      if (old(key) !== undefined) {
        await config.update(key, undefined, target);
      }
    }
  }
}
