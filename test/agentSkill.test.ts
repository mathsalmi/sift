import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SKILL_TEXT, chosenAgents, skillsDir, syncAgentSkills, syncSkill } from '../src/ai/agentSkill';

let home: string;
const skillFile = (agentDir: string) => path.join(home, agentDir, 'skills', 'sift', 'SKILL.md');
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'sift-skill-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('agent skill', () => {
  it('follows Choose AI until the user lists agents', () => {
    expect(chosenAgents(undefined, 'claude')).toEqual(['claude']);
    expect(chosenAgents(undefined, 'vscode')).toEqual([]);
    expect(chosenAgents(['gemini', 'codex', 'nope'], 'claude')).toEqual(['codex', 'gemini']);
    expect(chosenAgents([], 'claude')).toEqual([]);
  });

  it('writes only to the chosen agents, each in its own folder', async () => {
    for (const dir of ['.claude', '.codex', '.gemini']) {
      mkdirSync(path.join(home, dir));
    }
    await syncAgentSkills(['claude'], {}, home);
    expect(readFileSync(skillFile('.claude'), 'utf8')).toBe(SKILL_TEXT);
    expect(existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
    expect(existsSync(path.join(home, '.gemini', 'skills'))).toBe(false);
    expect(existsSync(path.join(home, '.agents'))).toBe(false);
    expect(SKILL_TEXT).toMatch(/^---\nname: sift\ndescription: .+\n---\n/);

    await syncAgentSkills(['codex'], {}, home);
    expect(existsSync(skillFile('.claude'))).toBe(false);
    expect(readFileSync(skillFile('.codex'), 'utf8')).toBe(SKILL_TEXT);

    await syncAgentSkills([], {}, home);
    expect(existsSync(skillFile('.codex'))).toBe(false);
  });

  it('creates nothing for an agent that is not installed', async () => {
    await syncAgentSkills(['claude', 'codex', 'gemini'], {}, home);
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);
    expect(existsSync(path.join(home, '.gemini'))).toBe(false);
  });

  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    const env = { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' };
    expect(skillsDir('claude', env, home)).toBe(path.join('/c', 'skills'));
    expect(skillsDir('codex', env, home)).toBe(path.join('/x', 'skills'));
    expect(skillsDir('gemini', env, home)).toBe(path.join(home, '.gemini', 'skills'));
  });

  it('updates its own skill and leaves a sift skill it did not write alone', async () => {
    const dir = path.join(home, 'skills');
    expect(await syncSkill(dir, true)).toBe('installed');
    expect(await syncSkill(dir, true)).toBe('unchanged');
    writeFileSync(path.join(dir, 'sift', 'SKILL.md'), SKILL_TEXT.replace('# Sift', '# Old Sift'));
    expect(await syncSkill(dir, true)).toBe('updated');

    writeFileSync(path.join(dir, 'sift', 'SKILL.md'), 'mine');
    expect(await syncSkill(dir, true)).toBe('skipped');
    expect(await syncSkill(dir, false)).toBe('skipped');
    expect(readFileSync(path.join(dir, 'sift', 'SKILL.md'), 'utf8')).toBe('mine');
  });
});
