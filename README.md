# Sift

Sift a large AI-made change set into reviewed, atomic commits — one commit at a time, with a snapshot per review round and Claude in the loop.

Status: **0.3.0** — file-level review with snapshots, inline comments, Claude's explanations and the Send to Claude loop over MCP. Hunk-level commits (M3) come next. Full spec: the extension spec doc ("Commit Review — VS Code Extension Spec").

## Build and run

```bash
npm install
npm test            # model, git, controller and MCP loop tests against temp git repos
npm run build       # bundles dist/extension.js
```

- **Try it:** open this folder in VS Code and press **F5**. A new window opens with the extension loaded; open the repo you want to review in that window.
- **Install privately:** `npm run package` creates `sift-0.3.0.vsix`, then `code --install-extension sift-0.3.0.vsix`.

## Connect Claude Code (once per repo)

In the Sift view, open the **…** menu → **Set up Claude Code (MCP)**. It does three things and tells you if each worked:

1. Registers this window's MCP server for the repo (`claude mcp add --scope local …`, so nothing is added to the repo).
2. Installs the `/sift` command at `~/.claude/commands/sift.md`.
3. Sets `env.MCP_TOOL_TIMEOUT` in `~/.claude/settings.json` (only if you haven't set it), so long waits work in both the terminal and the VS Code Claude panel.

Then restart Claude Code (terminal or panel) and run `/sift`. If the command isn't found, `/mcp__sift__start` does the same thing; it comes straight from the MCP server.

Upgrading from the "Commit Review" builds: setup also removes the old `commit-review` MCP registration and `~/.claude/commands/commit-review.md`. Finish or abort any old session first; old `.commit-review/` folders can be deleted.

Setup needs the `claude` CLI in your login shell. If it isn't found, the error dialog offers to copy the command so you can run it yourself.

The MCP server runs inside VS Code on `127.0.0.1` only, with a per-repo bearer token, while the window is open. If you change `sift.mcpPort`, run setup again.

## Workflow

1. In the repo with your uncommitted changes, click **Start review** in the Sift view.
2. In Claude Code (terminal or the VS Code panel), run **`/sift`**. Claude reads the changes, writes the plan (atomic commits), starts the first commit and adds explanations. Alternatives: **Load plan** from `.sift/plan.json`, or **New commit** + drag files.
3. Review each file in the native diff editor:
   - Click **+** in the gutter to comment for Claude. Comments are threads: Open → Sent to Claude → Answered → Resolved.
   - **Show / hide Claude's explanations** (💡) toggles Claude's notes. Hidden by default.
   - Mark a file reviewed with ✓ or **Cmd+Alt+D**; the next file to do opens.
4. Click **Send to Claude** (**Cmd+Alt+Enter**). Claude applies every sent thread, replies in each, and calls `review_mark_ready`. That takes the next snapshot and hands the turn back to you. The status bar shows whose turn it is.
5. Review the round:
   - **This round** diff (default): previous version ↔ working tree, so you see only Claude's changes.
   - **Cumulative** (**Cmd+Alt+M**): HEAD ↔ working tree, i.e. what will be committed.
   - **Compare versions…** any two versions.
   - Files marked done that changed in the round go back to **In progress** ("changed in vN").
6. Repeat 3–5 until the commit is right, then **Approve and commit**. The extension stages exactly that commit's files and commits with your git identity and hooks. Claude gets the approval and moves to the next commit.
7. When every commit is done, push as usual.

Pause any time: close VS Code and come back; in a new Claude session run `/sift` again. All state is on disk.

If Claude isn't running, **Copy prompt for Claude** copies a one-line instruction to paste into any Claude Code session.

## Plan file format

`.sift/plan.json` (for **Load plan**; Claude normally uses `review_set_plan` instead)

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

- Every path must be a changed file; a path may appear only once. From a file, unlisted files stay **Unassigned**; from Claude, every file must be listed.
- A new plan replaces commits that aren't committed yet; committed ones are kept.

## MCP tools

| Tool | What it does |
| --- | --- |
| `review_get_status` | Session, plan, commit in review, whose turn, and the next step |
| `review_get_changes` | Changed files with commit and review status |
| `review_set_plan` | Replace the pending plan; every pending file exactly once |
| `review_assign_files` | Move files between commits (after the user agrees) |
| `review_start_commit` | Put a commit into review (snapshot v0) |
| `review_explain` | Claude's note on a line (1-based); replaces an earlier note on that line |
| `review_wait_for_feedback` | Blocks until Send to Claude (`feedback`) or Approve (`approved`); `none` on timeout |
| `review_get_feedback` | Same, without waiting |
| `review_reply` | Reply in a thread; optionally resolve it |
| `review_mark_ready` | Snapshot the round, show the summary, hand the turn back |
| `review_commit_done` | Acknowledge an approval; returns the next commit or `done` |

Claude can't stage, commit or mark files reviewed. Only your clicks do that.

## Commands and keys

| Command | Mac key |
| --- | --- |
| Send to Claude | Cmd+Alt+Enter |
| Mark reviewed (done) | Cmd+Alt+D |
| Mark to do | Cmd+Alt+U |
| Next to do | Cmd+Alt+N |
| Toggle diff mode | Cmd+Alt+M |

Also: Start review · Load plan · New commit · Start reviewing this commit · Take snapshot · Compare versions… · Show / hide Claude's explanations · Move to commit… · Approve and commit · Set up Claude Code (MCP) · Install /sift command · Copy prompt for Claude · Refresh changes · Abort session.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `sift.stateLocation` | `repo` | `repo` = `.sift/state.json` (excluded via `.git/info/exclude`); `workspaceStorage` = outside the repo |
| `sift.snapshotMaxFileSizeMB` | `5` | New files larger than this are left out of snapshots |
| `sift.mcpPort` | `47821` | Port of the local MCP server; use a different one per open window |

## How it works

- **Snapshots** are git trees built with a private index (`.git/sift/index`) and kept under `refs/sift/<session>/<commit>/v<N>`. Your real index is never touched until you approve.
- **Comments** are stored in the state file and anchored by line text, so they follow code that moves. A thread whose line is gone shows as outdated.
- **Approve** refuses if the index already has staged changes or HEAD moved outside the extension (Refresh to accept the new HEAD).
- **Abort** deletes the state and snapshot refs; your files and existing commits are untouched.
- Renames count as delete + add for now.

## Layout

```text
src/
  extension.ts            activation, commands, file watcher, MCP startup
  controller/             ReviewController: single owner of state, feedback waiters
  core/                   ReviewModel (pure rules), anchors, types
  git/                    GitRunner, changes + commit, SnapshotService
  mcp/                    tools (what Claude can do) and the HTTP server
  state/                  StateStore (atomic JSON)
  ui/                     trees, comments, status bar, snapshot URIs
resources/sift.md  the /sift slash command
test/                     vitest: model, anchors, git, controller, MCP loop
```
