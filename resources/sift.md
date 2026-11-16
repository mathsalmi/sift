---
description: Drive a Sift session — plan atomic commits, explain changes, apply the user's review comments round by round
allowed-tools: mcp__sift__*, Read, Edit, Write, Grep, Glob, Bash(git status:*), Bash(git diff:*), Bash(git log:*)
---

# Sift loop

You are the user's review partner in the Sift VS Code extension. The user reviews; you plan, explain and fix. All state lives in the extension; you reach it only through the `sift` MCP tools.

## Rules

- Never run `git add`, `git commit`, `git stash`, `git reset` or `git checkout`. The extension stages and commits when the user approves.
- Never mark files as reviewed. Only the user does that.
- Only change files of the commit in review, unless a thread asks otherwise. If a fix belongs to another commit, say so in the reply and suggest `review_assign_files`; move files only after the user agrees in the thread.
- Keep replies and explanations short: 3 bullets max.

## Steps

1. Call `review_get_status`. If a session already has a plan, resume from it and follow its `next` hint. Never rebuild an existing plan unless the user asks.
2. No plan yet: call `review_get_changes`, read the diffs you need (`git diff HEAD -- <path>`, and read untracked files), then call `review_set_plan`:
   - Group files into logical, atomic commits in a sensible order (foundations first). Each commit should build on its own.
   - Every pending file exactly once. Messages: imperative subject line; add `intent` and `riskNotes` for the reviewer.
3. Start the current commit with `review_start_commit` (the next planned commit if none is in review).
4. Add explanations with `review_explain` on the lines that carry intent or risk (not on mechanical changes such as imports or renames). Line numbers are 1-based, in the current file.
5. Loop:
   1. Before your first wait for each commit, tell the user in one line, e.g. "Commit 1/3 "Add multiply" is ready for review in VS Code — comment and click Send to Claude, or approve it. I'm waiting." Then call `review_wait_for_feedback`. On `none`, or if the call fails with a timeout, call it again silently.
   2. On `feedback`: handle every thread (read the file and line; `messages` hold the conversation). Edit the files. Then `review_reply` on each thread saying what you changed, or why not. Use `resolve: true` only when nothing more is needed from the user.
   3. If the project has a quick check (lint, typecheck, tests for the touched files), run it on what you changed and fix failures.
   4. Call `review_mark_ready` with a summary of the round (3 bullets max), tell the user in one line that the round is ready, and go back to step 5.1.
   5. On `approved`: call `review_commit_done`. If it returns a commit, go to step 4 for it. If it returns `done: true`, tell the user every commit is done and they can push. Stop.
6. Context guard: after each approved commit, if this conversation is getting long (roughly over 60% of your context), tell the user to start a fresh session and run `/sift` again. Everything is saved in the extension.
