---
name: multi-session-git
description: Safe git when several agent sessions, terminals or people share one repository - check which branch HEAD is really on before every commit, work in your own git worktree instead of switching branches, stage explicit files only, and prove after every push that your commit is on the remote branch. Use before any `git commit`, `git push`, `git checkout`/`switch`, `git stash`, `git reset` or `git add -A` in a repo another session may be using, when running parallel agents, and when the user says "commit this", "push it", "ship it", "another session is working here", "use a worktree", or a push "succeeded" but the change is missing.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/git-guard.mjs *)
---

# Git when sessions share a repo

Two sessions in one folder share one HEAD, one index and one working tree. When session B runs
`git checkout feature-x`, session A's next commit lands on `feature-x`, and A's `git push origin main`
prints success while pushing nothing. Then someone says "it's live". Every rule below exists to make that impossible.

## Before every commit

```bash
node ${CLAUDE_SKILL_DIR}/git-guard.mjs preflight --repo /full/path/to/repo --branch <the branch you think you are on>
```

`${CLAUDE_SKILL_DIR}` is this skill's folder. It prints the real branch, upstream distance, what is staged,
what is modified, and every worktree. Exit 1 = HEAD is not your branch, is detached, or your branch is checked
out in another worktree. Then **do not commit here and do not checkout**; move to your own worktree (below).

## Rules

1. **Address the repo by path, never by `cd`.** `git -C /full/path/to/repo status`. A `cd` in one command is easy to lose; `-C` is explicit in every command and every log line.
2. **Read the branch before you commit**: `git -C <repo> rev-parse --abbrev-ref HEAD`, or the preflight above. If it is not the branch you started on, someone else moved it.
3. **Never `checkout`/`switch` a shared folder to another branch**, and never check out someone else's branch to "take a look". Use `git -C <repo> show <branch>:<file>` or `git -C <repo> log <branch>` to read it.
4. **Your own worktree for your own work:**
   ```bash
   git -C /full/path/to/repo fetch origin
   git -C /full/path/to/repo worktree add -b <your-task> /full/path/to/repo-wt-<your-task> origin/main
   ```
   Work, commit and push from that path. Remove it when merged: `git -C /full/path/to/repo worktree remove /full/path/to/repo-wt-<your-task>`.
5. **Stage explicit files only**: `git -C <repo> add src/a.ts src/b.ts`. Never `git add -A`, `git add .` or `git commit -a`: they sweep in another session's half-done files, generated files, and `.env`. Check `git -C <repo> diff --cached --stat` before committing.
6. **Do not touch what is not yours**: no `git stash`, `git reset --hard`, `git checkout -- <file>`, `git clean` on files you did not change. Modified files you did not touch belong to another session.
7. **After every push, verify it landed:**
   ```bash
   node ${CLAUDE_SKILL_DIR}/git-guard.mjs verify-push --repo /full/path/to/repo --branch main
   ```
   It asks the server (`git ls-remote`), not your local tracking ref, whether your commit is in the remote branch. Or by hand: `git -C <repo> fetch origin && git -C <repo> log -1 origin/main`. "Everything up-to-date" after a commit is a red flag, not a success.
8. **Never force-push a shared branch** (`main`, `production`, a branch someone else pushed to). If a push is rejected, fetch and rebase your own commits; do not overwrite theirs.
9. **One writer per branch.** If two sessions must touch the same branch, serialize: one commits and pushes, the other fetches and rebases before its own commit.
10. **Pushed is not deployed.** After a verified push, use `prove-its-live` before saying anything is live.

## When things already went wrong

- Commit landed on the wrong branch: note its SHA (`git -C <repo> log -1`), move to your own worktree on the right branch, `git cherry-pick <sha>`, push, verify. Tell the user the commit is also on the other branch; do not rewrite that branch without asking its owner.
- Push printed success but `verify-push` says NOT on the remote: you pushed a different branch than the one holding your commit. Push the right one (`git -C <repo> push origin <your-branch>`), then verify again.
- Unsure who owns a change: ask, do not discard.
