import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marks the skill as Sift's own, so Sift only ever rewrites or removes the file it wrote. */
const MARKER = '<!-- Written by the Sift VS Code extension. It is rewritten when Sift updates; edits are lost. -->';

/**
 * An agent skill (the SKILL.md format Claude Code, Codex and Gemini CLI share) that tells the agent
 * what Sift is and how to change its plan. Agents read skills' descriptions in every session, so
 * "plan the commits in Sift" works without explaining Sift.
 */
export const SKILL_TEXT = `---
name: sift
description: Plan, split or regroup the uncommitted git changes into commits in Sift, the user's VS Code commit review extension. Use when the user asks to plan, organize, split, group or regroup commits "in Sift", to move files between Sift commits, or to change Sift's plan.
---

${MARKER}

# Sift

Sift is a VS Code extension in which the user reviews uncommitted changes as a plan of atomic commits, then commits them. You plan; the user reviews, approves and commits in Sift.

## Rules

- Never run \`git add\`, \`git commit\`, \`git stash\`, \`git reset\` or \`git checkout\`. Sift stages and commits when the user approves.
- Never edit \`.sift/state.json\`. It is Sift's own file. You may read it.
- You change the plan only by writing \`.sift/plan.json\`.

## Plan the commits

1. See what changed: \`git status --porcelain=v1 -uall\` and \`git diff HEAD\`. Read untracked files you need.
2. If \`.sift/state.json\` exists, read it to see the current plan. Each entry of \`commits\` has an \`id\` and a \`message\`. Each entry of \`files\` has a \`path\` and a \`commitId\` (\`null\` is Unassigned); a file split across commits has one entry per commit, and those with \`hunks\` list the blocks they hold by first line (\`start\`) and line count (\`lines\`). Keep the user's grouping where it still makes sense, and keep a commit's exact message to keep its review.
3. Group the changed files into logical, atomic commits in a sensible order, foundations first. Each commit should build and pass its tests on its own.
4. Write \`.sift/plan.json\` (create \`.sift/\` if needed):

\`\`\`json
{
  "commits": [
    {
      "message": "Add snapshot service",
      "intent": "What this commit does and why, 1-2 sentences, for the reviewer.",
      "riskNotes": ["Spots that deserve careful review"],
      "files": ["src/git/SnapshotService.ts", "test/git.test.ts"],
      "dependsOn": [],
      "explanations": [
        { "path": "src/git/SnapshotService.ts", "line": 42, "body": "Why this line changed, short." }
      ]
    }
  ]
}
\`\`\`

- \`files\`: repo-relative paths exactly as git lists them; only files git lists as changed. Each file in one commit, unless you split it (below). Files you leave out go to Unassigned.
- \`message\`: imperative subject line, at most 72 characters; a body may follow after a blank line.
- \`dependsOn\` (optional): 1-based positions of earlier commits in this plan that this one needs.
- \`explanations\` (optional): notes shown on the diff. \`path\` must be one of the commit's files; \`line\` is 1-based in the current file. Put them only on lines that carry intent or risk, not on imports or renames.
- To split one file's changes across commits, list it in each of those commits as \`{ "path": "src/a.ts", "lines": [[12, 18], 40] }\`. \`lines\` are 1-based line ranges \`[first, last]\` or single lines in the current file; the commit gets every block of changes they touch. Read the blocks with \`git diff -U0 HEAD -- <file>\`: in a header \`@@ -a,b +c,d @@\`, the block is lines c to c+d-1, and a deletion (d = 0) is at line c, the line just above where it was (line 1 at the top of the file). A plain path in one of the commits takes the rest; with none, the rest goes to Unassigned. A block can't be cut further, and only changes to existing text files can be split.

## After writing the plan

Sift picks up \`.sift/plan.json\` on its own, applies it and deletes the file. The new plan replaces the commits not committed yet. A commit with the same message, or with most of the same files, keeps its review. Sift asks the user first only when the plan drops a commit they already started reviewing.

Check that the file is gone after a few seconds. If it is still there, Sift could not load it (invalid JSON, or a path that isn't a changed file) and shows the reason in VS Code: fix the file. If the user isn't running VS Code with Sift, the file waits until they open the repository.

Then tell the user the plan is in Sift, in a short list of the commits.
`;

export type SkillAgent = 'claude' | 'codex' | 'gemini';
export const SKILL_AGENTS: SkillAgent[] = ['claude', 'codex', 'gemini'];

/**
 * Each agent's own skills folder. Sift never writes to the shared ~/.agents/skills: Codex and Gemini
 * CLI both read it, so a skill there would reach an agent the user didn't choose.
 */
export function skillsDir(agent: SkillAgent, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  switch (agent) {
    case 'claude':
      return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills');
    case 'codex':
      return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills');
    case 'gemini':
      return path.join(home, '.gemini', 'skills');
  }
}

/**
 * The agents to install the skill for: the \`sift.agentSkills\` setting when the user set it,
 * otherwise the agent chosen to run Sift's AI (Choose AI), if it is one of them.
 */
export function chosenAgents(setting: unknown, provider: string): SkillAgent[] {
  if (Array.isArray(setting)) {
    return SKILL_AGENTS.filter((agent) => setting.includes(agent));
  }
  return SKILL_AGENTS.filter((agent) => agent === provider);
}

/**
 * Installs or updates the skill for the chosen agents and removes Sift's skill from the others.
 * An agent that isn't set up on this machine (no config folder) is left alone: nothing is created
 * for it, and it gets the skill on a later sync once it is installed.
 */
export async function syncAgentSkills(chosen: SkillAgent[], env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<void> {
  for (const agent of SKILL_AGENTS) {
    const dir = skillsDir(agent, env, home);
    const wanted = chosen.includes(agent);
    if (wanted && !(await isDirectory(path.dirname(dir)))) {
      continue;
    }
    await syncSkill(dir, wanted).catch(() => undefined);
  }
}

function isDirectory(dir: string): Promise<boolean> {
  return fs.stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Writes or updates Sift's skill in one skills folder, or removes it when \`enabled\` is false. Leaves
 * a \`sift\` skill alone that Sift didn't write. Returns what it did.
 */
export async function syncSkill(skillsDir: string, enabled: boolean): Promise<'installed' | 'updated' | 'removed' | 'unchanged' | 'skipped'> {
  const dir = path.join(skillsDir, 'sift');
  const file = path.join(dir, 'SKILL.md');
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current !== null && !current.includes(MARKER)) {
    return 'skipped';
  }
  if (!enabled) {
    if (current === null) {
      return 'unchanged';
    }
    await fs.rm(dir, { recursive: true, force: true });
    return 'removed';
  }
  if (current === SKILL_TEXT) {
    return 'unchanged';
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, SKILL_TEXT);
  return current === null ? 'installed' : 'updated';
}
