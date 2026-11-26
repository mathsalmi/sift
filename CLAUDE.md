# Sift

Sift is a VS Code extension for turning uncommitted changes into reviewed, atomic commits, together with an AI. The user plans (or lets an AI plan) commits, reviews each file's diff, talks to the AI in inline comment threads, approves, and commits and pushes, all from the Sift view.

## Product principles

These come from the owner's feedback. Follow them in every change.

- **Sift is a productive UI, not a backend for an agent.** It must work on its own: its own AI planning and answers through the chosen provider, with no MCP server and no agent waiting on the user.
- **The user and the AI can do the same things.** Every action the user can take in Sift (assign, move or split changes, plan) must also be possible for agents: through `.sift/plan.json`, the `sift_*` language model tools for Copilot, and the `sift` agent skill. Never ship an action as "UI only, ask the user to do it in Sift". Extend the plan format, the tools and the skill text in the same change.
- **Changes from outside show up without clicks.** Sift picks up plan and state changes made by other tools automatically. Never make the user press Refresh or reload the window to see them.
- **An action is available everywhere it belongs, or nowhere.** No palette-only or button-only commands. When removing a feature, remove its command too. The same options appear, in the same order, in the sidebar, editor tab and diff editor menus.
- **Native look and wording.**
  - Command, menu and picker labels never end with "…". Pickers' placeholders say what to pick.
  - Use VS Code's own conventions (codicons, `when` clauses, a check icon for approve).
  - Destructive actions get a modal warning with a confirming button. For example, **Discard Plan** says the plan is lost but the files are not.
- **Diff editor actions live under one Sift menu** (the Sift icon), so the user can tell Sift's buttons from other extensions'.
- **Generic AI, not Claude-specific.** Providers are Claude Code, Codex, Gemini CLI, VS Code language models and custom commands. Settings, labels and prompts must not assume Claude.
- **Don't clutter the user's machine or repository.** Sift writes only what it needs:
  - `.sift/state.json`, excluded via `.git/info/exclude`.
  - `.sift/plan.json`, which is a drop box deleted once applied.
  - The agent skill, only for the agents the user chose.
- **Git is the source of truth.** Sift must never fight the user's git state:
  - Staged files appear in Unassigned like any other change. They are never an error.
  - Sift commits with a private index, so what the user staged stays staged.
- **Fewer, clearer features.** The owner removes features nobody uses: the Board panel, the manual snapshot button, the old Commit Review MCP flow. Prefer removing to hiding.

## Build, test, install

- `npm test` runs vitest on real temporary git repos (`test/helpers.ts`). `npm run typecheck` runs tsc.
- Run both before every commit. Add tests for new behavior.
- `test/vscode-mock.ts` stubs the VS Code API. Extend it when code uses a new API.
- Install locally with the **Install Sift** build task (Cmd+Shift+B). It runs `npm run package -- --out sift.vsix && code --install-extension sift.vsix --force`. Then the owner reloads the window.
- CI (`.github/workflows/ci.yml`) runs typecheck and tests on Linux, macOS and Windows. Keep tests portable: build paths with `path.join`, and don't assume `/` or `\n` line endings from the platform.

## Versions and releases

- Sift follows semantic versioning, `MAJOR.MINOR.PATCH`, starting at 1.0.0:
  - **PATCH** for fixes that change no behavior the user relies on.
  - **MINOR** for new features, commands or settings that keep existing ones working.
  - **MAJOR** when something users or agents rely on breaks: a removed or renamed command or setting, an incompatible `.sift/plan.json` or `.sift/state.json` format, a changed `sift_*` tool contract.
- Bump the version in `package.json` in its own commit right before a release, not with each change.
- There is no `CHANGELOG.md`. The notes live in the GitHub release.
- To release: create a GitHub release with a tag `v<version>` matching `package.json`, and write the notes there. Tick **Set as a pre-release** for one only opt-in users should get. `.github/workflows/release.yml` builds the `.vsix`, attaches it to the release and publishes to Open VSX when the `OVSX_PAT` secret is set. The Marketplace takes no tokens: the owner uploads the `.vsix` at marketplace.visualstudio.com/manage.

## Code map

- `src/extension.ts` registers commands, menus, context keys and watchers. Wrap every command with `register`, which reloads state first.
- `src/controller/ReviewController.ts` holds git, snapshots, persistence and plan file handling.
- `src/core/ReviewModel.ts` holds the pure review state: plan, files, parts of split files, threads, sync with git facts. `src/core/types.ts` holds the types.
- `src/git/`:
  - `changes.ts`: commit, discard, amend and branch status.
  - `hunks.ts`: zero-context hunks, keyed by content.
  - `history.ts`: commit refs under `refs/sift/<session>/<commit>`.
  - `SnapshotService.ts`: review versions.
  - `ignore.ts`: `.gitignore` and `.git/info/exclude`.
  - `vscodeGit.ts`: fetch and pull through VS Code's Git extension.
- `src/ai/`:
  - `providers.ts`: command line and VS Code model providers.
  - `prompts.ts`: prompts, plus `PLAN_SCHEMA` and `ANSWER_SCHEMA`.
  - `AiService.ts`: planning and thread answers.
  - `agentTools.ts`: Copilot `sift_*` tools.
  - `agentSkill.ts`: the `sift` skill Sift installs for Claude Code, Codex or Gemini CLI.
- `src/ui/`: the plan tree, comments, decorations, the status bar and the snapshot content provider.

## Invariants worth knowing

- **State.** `.sift/state.json` is Sift's own file. External tools change the plan only by writing `.sift/plan.json`. Sift applies it, deletes it, and asks first only when commits under review would be lost.
- **Stale saves.** Saving refuses to overwrite a state file that changed since Sift read it (`StaleStateError`).
- **Committed commits** are found from git history and private refs, never from trailers in commit messages. Don't add trailers.
- **Approvals** are tied to content: the blob id, or `hunks:<signature>` for a part of a split file. A file changed after approval goes back to In progress and shows only what changed since approval.
- **Split files** have one entry per commit. Entries with `hunks` list their blocks of changes; the entry without `hunks` holds the rest. `part` is derived and never saved.
- **Planning a split** in a plan uses `{ "path", "lines": [[first, last], n] }`. These are working-tree line numbers, and a pure deletion sits at the line above it.
- **Dependencies** (`dependsOn`) are hard. Reordering never puts a commit before the commits it needs.

## Working with the owner

- "commit and push" means commit straight to `main` and push. Use no attribution lines or trailers. Split the work into separate commits when asked, or when changes are unrelated.
- Update `README.md` with every user-visible change: commands, menus, settings, the plan format.
- When the owner asks to "plan the commits in Sift", write `.sift/plan.json` as the `sift` skill describes. Don't commit with git yourself.
- Keep messages and UI text short and plain.
