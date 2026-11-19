# Sift

**Sift a large change set into reviewed, atomic commits, and ask the AI of your choice about any line.**

When an AI (or you) changes hundreds of files in one go, reviewing a single giant diff doesn't work, and committing it as one blob loses history. Sift asks an AI to split the changes into a plan of atomic commits, with notes on the lines that matter, then walks you through each commit in VS Code's native diff editor. Comment on any line to ask a question or ask for a change, and the answer lands in the same thread. When a commit is right, you approve it and Sift commits exactly those files.

> Status: early (0.3.0). Used daily by its author; not on the Marketplace yet.

## Features

- **AI commit plan:** one click groups every changed file into ordered, atomic commits, with an intent, risk notes and explanations on the lines that matter. Drag files between commits to adjust.
- **Ask about any line:** in a comment, ask a question (the AI answers in the thread) or give a direction (the AI edits the code and says what it changed). Markdown works, **Cmd+Enter** sends, and the thread shows *Thinking…* while the AI works. Edit or delete your own comments.
- **Your choice of AI:** Claude Code (uses your Claude login, e.g. through the Claude Code extension), any model VS Code exposes (GitHub Copilot or other extensions), or any command line tool.
- **Versions per file:** Sift freezes your files in a snapshot when a commit's review starts and after each AI edit, and every file gets its own version numbers: a file goes from v0 to v1 only when a round changed it, so an untouched file stays at v0 while another reaches v7. You can diff:
  - **Latest change** ("This round"): the file's previous version ↔ working tree, while the change is unseen.
  - **Cumulative:** HEAD ↔ working tree, i.e. what will be committed.
  - **Any of the file's versions ↔ now,** e.g. v1 ↔ working tree.

  Pick one with the **Compare with** dropdown in the diff editor title.
- **Native VS Code:** real diff editor, inline comment threads, go-to-definition and editing inside the diff all keep working.
- **Files as a list or a tree:** switch with the list/tree button in the view title, like the Source Control view. Collapse or expand everything with the button next to it.
- **Locally excluded files:** a **Locally excluded** group at the end of the plan lists the rules in `.git/info/exclude` (except Sift's own `.sift/`). Click a file to open it; **Remove from .git/info/exclude** (eye button or right-click) brings its changes back into the review. Edits to the file by hand show up right away.
- **Hide approved files:** the eye button in the view title hides files as soon as you approve them, so only what's left to review stays in view. Approved files are shown by default.
- **Review status:** tick a file's checkbox to approve it. Sift asks first when the file still has unresolved comments. A commit is **To do** until one file is approved, **In progress** while some are, and **Approved** when all are. Files that change after you approved them go back to In progress.
- **You stay in control:** the AI never stages or commits. Only your Approve click commits, with your git identity and hooks.

## Requirements

- VS Code 1.95 or later
- Git
- An AI, any of:
  - [Claude Code](https://claude.com/claude-code): the VS Code extension or the CLI. Sift finds the extension's bundled `claude` binary by itself.
  - A VS Code language model, e.g. from GitHub Copilot Chat.
  - A command line tool that reads a prompt on stdin, e.g. `codex exec -`, `gemini -p`, `llm`.

Sift also works without AI for manual reviews.

## Install

Sift isn't on the Marketplace yet. Build and install the `.vsix`:

```bash
git clone https://github.com/mathsalmi/sift.git
cd sift
npm install
npm run package
code --install-extension sift-0.3.0.vsix --force
```

Then run **Developer: Reload Window**.

## Quick start

1. Open a repo with uncommitted changes and click the **Sift** icon in the activity bar.
2. Click **Plan commits with AI** (✨). The plan appears in the Sift view, with explanations on the changed lines. To pick another AI, use **Choose AI…** in the **…** menu.
3. Click a file of the first commit: that commit goes into review. In the diff editor, step through its files with **←** / **→**.
4. On any line, click **+** in the gutter and write a question or a direction:
   - **Ask AI** sends it now; the answer appears in the thread (stop it with ⏹).
   - **Add (ask later)** queues it; ask about all queued comments with ✨ in the editor title (**Cmd+Alt+Enter**).
5. Approve each file: tick its checkbox in the tree, or click **✓** in the diff editor (**Cmd+Alt+D**).
6. When the commit is approved, click **Approve and commit**. The next commit goes into review.
7. When every commit is done, push.

Safety tip: create a backup branch before a big review: `git branch backup/$(date +%Y%m%d-%H%M)`.

## Choosing the AI

Run **Sift: Choose AI…**. It lists what is available here and saves your choice in your user settings:

| Provider | How Sift calls it |
| --- | --- |
| **Claude Code** | Runs `claude -p` with read-only tools and a JSON schema. Uses the binary bundled with the Claude Code VS Code extension, else `claude` from your login shell. Pick the default model, opus, sonnet or haiku. |
| **VS Code language models** | Any model registered in VS Code, e.g. by GitHub Copilot Chat. VS Code asks you once to allow Sift to use it. |
| **Command line tool** | Any command, run in your login shell at the repo root. It gets the prompt on stdin and must print an answer containing the JSON. |

## Plan file

Sift also picks up `.sift/plan.json` whenever it is written, by hand or by another tool. With no session it starts one; if it would replace a plan under review, Sift asks first.

```json
{
  "commits": [
    {
      "message": "Add snapshot service",
      "intent": "Freeze the working tree per review round without touching the index.",
      "riskNotes": ["Uses a private GIT_INDEX_FILE"],
      "files": ["src/git/SnapshotService.ts", "test/git.test.ts"],
      "explanations": [
        { "path": "src/git/SnapshotService.ts", "line": 42, "body": "Writes the tree with a private index so the staging area is untouched." }
      ]
    }
  ]
}
```

- Every path must be a changed file, listed once. Unlisted files stay in **Unassigned**.
- `explanations` are optional; each `path` must be one of the commit's files, `line` is 1-based.
- A new plan replaces commits that aren't committed yet.

## Commands and keys

| Command | Mac | Windows / Linux |
| --- | --- | --- |
| Ask AI about all open comments | Cmd+Alt+Enter | Ctrl+Alt+Enter |
| Approve file | Cmd+Alt+D | Ctrl+Alt+D |
| Mark to do | Cmd+Alt+U | Ctrl+Alt+U |
| Next to do | Cmd+Alt+N | Ctrl+Alt+N |
| Toggle diff mode | Cmd+Alt+M | Ctrl+Alt+M |
| Send a comment (Ask AI) | Cmd+Enter | Ctrl+Enter |
| Open the Sift view (also when the sidebar is hidden) | Ctrl+Shift+S | Ctrl+Alt+S |

Diff editor buttons: Ask AI · Previous / next file in the commit · Approve / unapprove file · Compare with (previous version, last commit, or a specific version); and in its **…** menu: Next to do · Show / hide AI explanations.

Right-click a commit for: Approve and commit · Review this commit · Edit message · Move up / down · Delete. Right-click a file for: Approve / unapprove · Mark in progress / to do · Add to .gitignore · Exclude locally (.git/info/exclude) · Move to commit…. Right-click a locally excluded file for: Remove from .git/info/exclude. Right-click an editor tab of a review file for **Sift**: Show in Sift sidebar · Approve / unapprove · Mark in progress · Mark to do · Add to .gitignore · Exclude locally.

Also in the Sift view and command palette: Plan commits with AI · Choose AI… · Start review · Load plan · New commit · Refresh (re-reads git and the saved state) · Hide / show approved files · Remove from .git/info/exclude · View as tree / list · Collapse / expand all · Start over….

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sift.ai.provider` | `claude-code` | `claude-code`, `vscode-lm` or `command`. Easiest to set with **Choose AI…** |
| `sift.ai.claudeCodeModel` | empty | Claude Code model, e.g. `opus`, `sonnet`, `haiku`; empty for its default |
| `sift.ai.claudeCodePath` | empty | Path to `claude`; empty to use the Claude Code extension's binary or your shell's |
| `sift.ai.claudeCodeAdditionalDirectories` | `[]` | Folders outside the repo Claude Code may read, e.g. `~/code` for sibling worktrees |
| `sift.ai.claudeCodeAllowedTools` | `[]` | Extra tools Claude Code may use, e.g. `WebFetch` or `mcp__claude_ai_Atlassian` (all tools of that MCP server). Naming an MCP tool loads your MCP servers, which makes calls slower |
| `sift.ai.languageModel` | empty | VS Code language model id; empty for the first available |
| `sift.ai.command` | empty | Command for the `command` provider |
| `sift.stateLocation` | `repo` | `repo`: `.sift/state.json`, excluded via `.git/info/exclude`. `workspaceStorage`: outside the repo. |
| `sift.snapshotMaxFileSizeMB` | `5` | New files larger than this are left out of snapshots |

## How it works

- **Snapshots:** git trees built with a private index (`.git/sift/index`) and kept under `refs/sift/<session>/<commit>/v<N>`. Your real index isn't touched until you approve.
- **AI calls:** Sift sends the prompt (numbered diffs, the file, the thread) to the chosen AI and asks for JSON. Claude Code runs with read-only tools (`Read`, `Grep`, `Glob`) inside the repo, and no MCP servers or slash commands. A one-shot run cannot ask for permission, so anything else is denied unless you allow it with `sift.ai.claudeCodeAdditionalDirectories` or `sift.ai.claudeCodeAllowedTools`. Code changes come back as search/replace edits; Sift applies all of them or none, only inside the repo, then takes a new snapshot so the files the AI changed get a new version and "latest change" shows exactly what it did.
- **Comments:** stored in the state file and anchored by line text, so they follow code that moves. A thread whose line is gone shows as outdated.
- **State:** `.sift/state.json` holds only your decisions: the plan, file assignments, approvals, comments. What git knows is read from git every time and never saved: which files changed and how, and which planned commits are committed. Each commit Sift makes is recorded in `refs/sift/<session>/<commit>/commit`; nothing is added to commit messages.
- **Commits made outside Sift** (terminal, Source Control view, rebase, squash) are picked up as they happen, and when VS Code starts. A planned commit whose files no longer differ from HEAD is committed, linked to the newest commit that touched them; if no commit touched them they were reverted and the commit leaves the plan. A commit that leaves HEAD's history (`git reset`) goes back to the plan. Commits you created empty are left alone.
- **Approvals** cover the file's content when you approved it. Edit the file afterwards and it goes back to In progress ("changed since approval"), so a commit never includes code you didn't see.
- **Approve and commit:** catches up with git first, then refuses if the index already has staged changes.
- **Start over:** deletes the review state and snapshot refs. Your files and commits are untouched.

## Limitations and roadmap

- **Whole files per commit.** Splitting one file's hunks across commits is next (M3).
- **Renames** show as delete + add.
- **AI edits are plain file writes**, not editor undo steps. Use the "this round" diff or git to review or revert them.
- **Planned:** reviewing an already-committed range (rebase mode).

## Development

```bash
npm install
npm test            # model, git, controller and AI service tests against temp git repos
npm run build       # bundles dist/extension.js
npm run watch       # rebuild on change
npm run package     # typecheck, production build, .vsix
```

Press **F5** in VS Code to run the extension in an Extension Development Host. Press **Cmd+R** there to reload after a rebuild.

```text
src/
  extension.ts            activation, commands, file watchers
  ai/                     AiService (plan, answer threads, apply edits), prompts, providers
  controller/             ReviewController: single owner of state
  core/                   ReviewModel (pure rules), anchors, types
  git/                    GitRunner, changes + commit, SnapshotService
  state/                  StateStore (atomic JSON)
  ui/                     trees, comments, status bar, snapshot URIs
test/                     vitest suites
```

## License

[MIT](LICENSE) © 2026 Matheus Salmi
