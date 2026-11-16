# Sift

**Sift a large AI-made change set into reviewed, atomic commits — one commit at a time, with Claude in the review loop.**

When Claude changes hundreds of files in one task, reviewing a single giant diff doesn't work, and committing it as one blob loses history. Sift lets Claude propose a plan of atomic commits, then walks you through each commit in VS Code's native diff editor. You comment inline, Claude fixes and replies, and you see only what changed since the last round. When the commit is right, you approve it and Sift commits exactly those files.

> Status: early (0.3.0). Used daily by its author; not on the Marketplace yet.

## Features

- **Commit plan:** Claude (or you) groups every changed file into ordered, atomic commits. Drag files between commits.
- **Review rounds with snapshots:** each round is frozen as v0, v1, v2…, so you can diff:
  - **This round:** previous version ↔ working tree, i.e. only the latest fixes.
  - **Cumulative:** HEAD ↔ working tree, i.e. what will be committed.
  - **Any two versions,** e.g. v0 ↔ v3.
- **Native VS Code:** real diff editor, inline comment threads, go-to-definition and editing inside the diff all keep working.
- **Claude in the loop:** comment, press **Send to Claude**, and Claude applies each thread, replies in it, and hands the turn back.
- **Review status:** To do / In progress / Done per file, saved to disk. Files that change after you marked them done go back to In progress.
- **You stay in control:** Claude can't stage, commit or mark anything reviewed. Only your Approve click commits, with your git identity and hooks.

## Requirements

- VS Code 1.95 or later
- Git
- [Claude Code](https://claude.com/claude-code) (CLI or VS Code extension), for the Claude loop. Sift also works on its own for manual reviews.

## Install

Sift isn't on the Marketplace yet. Build and install the `.vsix`:

```bash
git clone https://github.com/mathsalmi/sift.git
cd sift
npm install
npm run package
code --install-extension sift-0.3.0.vsix
```

Then run **Developer: Reload Window**.

## Quick start

1. Open a repo with uncommitted changes and click the **Sift** icon in the activity bar.
2. Click **Start review**. All changed files land in **Unassigned**.
3. Connect Claude, once per repo: in the **…** menu, run **Set up Claude Code (MCP)**, then restart Claude Code.
4. In Claude Code, run **`/sift`**. Claude plans the commits, starts the first one, adds explanations and waits for you.
5. For each file in the commit:
   - Read the diff.
   - Comment with **+** in the gutter.
   - Mark it reviewed with **Cmd+Alt+D**.
6. Press **Cmd+Alt+Enter** (Send to Claude). Claude fixes, replies, and the next round is ready.
7. When the commit is right, click **Approve and commit**. Claude moves on to the next commit.
8. When every commit is done, push.

Safety tip: create a backup branch before a big review: `git branch backup/$(date +%Y%m%d-%H%M)`.

## Connecting Claude Code

**Set up Claude Code (MCP)** does three things and reports each one:

1. Registers this window's MCP server for the repo: `claude mcp add --scope local …`. Nothing is added to the repo.
2. Installs the `/sift` command at `~/.claude/commands/sift.md`.
3. Sets `env.MCP_TOOL_TIMEOUT` in `~/.claude/settings.json`, only if you haven't set it, so Claude can wait for your review. This works in both the terminal and the VS Code panel.

Notes:

- Setup needs the `claude` CLI in your login shell. If it's missing, the error dialog offers to copy the command so you can run it yourself.
- If `/sift` isn't found, use `/mcp__sift__start`. It comes straight from the MCP server.
- The MCP server listens on `127.0.0.1` only, uses a per-repo bearer token, and runs while the VS Code window is open.

### MCP tools

| Tool | What it does |
| --- | --- |
| `review_get_status` | Session, plan, commit in review, whose turn, and the next step |
| `review_get_changes` | Changed files with commit and review status |
| `review_set_plan` | Replace the pending plan; every pending file exactly once |
| `review_assign_files` | Move files between commits (after the user agrees) |
| `review_start_commit` | Put a commit into review (snapshot v0) |
| `review_explain` | Claude's note on a line; replaces an earlier note on that line |
| `review_wait_for_feedback` | Blocks until Send to Claude (`feedback`) or Approve (`approved`); `none` on timeout |
| `review_get_feedback` | Same, without waiting |
| `review_reply` | Reply in a thread; optionally resolve it |
| `review_mark_ready` | Snapshot the round, show the summary, hand the turn back |
| `review_commit_done` | Acknowledge an approval; returns the next commit or `done` |

## Plan file

Without Claude, write `.sift/plan.json` and click **Load plan**:

```json
{
  "commits": [
    {
      "message": "Add snapshot service",
      "intent": "Freeze the working tree per review round without touching the index.",
      "riskNotes": ["Uses a private GIT_INDEX_FILE"],
      "files": ["src/git/SnapshotService.ts", "test/git.test.ts"]
    }
  ]
}
```

- Every path must be a changed file, listed once.
- Unlisted files stay in **Unassigned**.
- A new plan replaces commits that aren't committed yet.

## Commands and keys

| Command | Mac | Windows / Linux |
| --- | --- | --- |
| Send to Claude | Cmd+Alt+Enter | Ctrl+Alt+Enter |
| Mark reviewed (done) | Cmd+Alt+D | Ctrl+Alt+D |
| Mark to do | Cmd+Alt+U | Ctrl+Alt+U |
| Next to do | Cmd+Alt+N | Ctrl+Alt+N |
| Toggle diff mode | Cmd+Alt+M | Ctrl+Alt+M |

Also in the Sift view and command palette: Start review · Load plan · New commit · Start reviewing this commit · Take snapshot · Compare versions… · Show / hide Claude's explanations · Move to commit… · Approve and commit · Set up Claude Code (MCP) · Copy prompt for Claude · Refresh changes · Abort session.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sift.stateLocation` | `repo` | `repo`: `.sift/state.json`, excluded via `.git/info/exclude`. `workspaceStorage`: outside the repo. |
| `sift.snapshotMaxFileSizeMB` | `5` | New files larger than this are left out of snapshots |
| `sift.mcpPort` | `47821` | Local MCP server port; use a different one per open window, then rerun setup |

## How it works

- **Snapshots:** git trees built with a private index (`.git/sift/index`) and kept under `refs/sift/<session>/<commit>/v<N>`. Your real index isn't touched until you approve.
- **Comments:** stored in the state file and anchored by line text, so they follow code that moves. A thread whose line is gone shows as outdated.
- **Approve:** refuses if the index already has staged changes or HEAD moved outside Sift. Run **Refresh changes** to accept the new HEAD.
- **Abort:** deletes the review state and snapshot refs. Your files and commits are untouched.

## Limitations and roadmap

- **Whole files per commit.** Splitting one file's hunks across commits is next (M3).
- **Renames** show as delete + add.
- **One window per port** for the MCP server.
- **Planned:** reviewing an already-committed range (rebase mode).

## Development

```bash
npm install
npm test            # model, git, controller and MCP loop tests against temp git repos
npm run build       # bundles dist/extension.js
npm run watch       # rebuild on change
npm run package     # typecheck, production build, .vsix
```

Press **F5** in VS Code to run the extension in an Extension Development Host. Press **Cmd+R** there to reload after a rebuild.

```text
src/
  extension.ts            activation, commands, file watcher, MCP startup
  claudeSetup.ts          one-click Claude Code setup
  controller/             ReviewController: single owner of state, feedback waiters
  core/                   ReviewModel (pure rules), anchors, types
  git/                    GitRunner, changes + commit, SnapshotService
  mcp/                    tools (what Claude can do) and the HTTP server
  state/                  StateStore (atomic JSON)
  ui/                     trees, comments, status bar, snapshot URIs
resources/sift.md         the /sift slash command
test/                     vitest suites
```

## License

[MIT](LICENSE) © 2026 Matheus Salmi
