---
name: permission-unblock
description: When a Claude Code tool call is refused - a permission prompt denied or unanswerable, "This command requires approval", "Blocked by classifier" / "Denied by auto mode classifier", a deny rule, or a PreToolUse hook - work out which gate refused it and output the exact, narrowest JSON rule for the project's .claude/settings.json (never user-global), or explain why no rule should be added. Use immediately on any denial, and when the user says "why was that blocked", "allow this command", "add a permission rule", "stop asking me for X", "open the permissions".
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/suggest-rule.mjs *)
---

# Permission unblock

A refusal comes from one of four gates, and each has a different fix. Adding an allow rule fixes only one
of them. Guessing wastes the user's time and teaches them to click "allow everything".

| Gate | Typical text | Fix |
|---|---|---|
| **Missing allow rule** | "requires approval", a prompt you could not get answered (headless, `dontAsk`) | narrowest `permissions.allow` rule in the project's `.claude/settings.json` |
| **User declined** | "the user doesn't want to proceed", a "No" at the prompt | **no rule.** Ask what they want instead. Never retry another way |
| **Deny rule** | "denied", a rule named in the message | allow can never override deny. `/permissions` shows which file holds it; only its owner changes it |
| **PreToolUse hook** | "hook", "PreToolUse:Bash hook error", a custom reason | allow rules do not help (a blocking hook runs first). Do what the hook asks, or the user changes the hook |
| **Auto mode classifier** | "Blocked by classifier", "Denied by auto mode classifier [Rule Name]" | see below |

## Run

```bash
node ${CLAUDE_SKILL_DIR}/suggest-rule.mjs --tool Bash --command "<the exact denied command>" --message "<the exact denial text>" --project /full/path/to/project
node ${CLAUDE_SKILL_DIR}/suggest-rule.mjs --tool WebFetch --url https://docs.example.com/page
node ${CLAUDE_SKILL_DIR}/suggest-rule.mjs --tool Edit --path src/app.ts --project /full/path/to/project
node ${CLAUDE_SKILL_DIR}/suggest-rule.mjs --tool mcp__github__create_issue
```

It prints the gate, what to do, one rule per part of a compound command, warnings, and the JSON block.

## Show the user, in this shape

1. **What was refused**: the exact command or tool call.
2. **Which gate**: one of the five above, and how you know (quote the message).
3. **The fix**: the JSON and the full path of the file:
   ```json
   {
     "permissions": {
       "allow": ["Bash(npm run build *)"]
     }
   }
   ```
   File: `/full/path/to/project/.claude/settings.json`. Merge into the existing `permissions.allow` array; do not replace the file. (`--write` merges it for them, without duplicates, after they approve.)
4. **What it allows and what it does not**, in one line: "allows `npm run build` with any arguments; not other npm scripts".

Writes to `.claude/` are protected, so expect to hand the user the JSON (or `/permissions` > Allow) rather than editing it yourself.

## Rules for the rule (from the current permission syntax)

- `Bash(npm run build *)`: `*` matches any text; a space before a trailing `*` also matches the bare command. `Bash(ls:*)` is the older equivalent form; prefer the space form, which the permission dialog writes.
- **Narrowest that covers the need**: program + subcommand (+ script name) + ` *`. Never `Bash(*)`, `Bash(git *)`, `Bash(node *)`, `Bash(npx *)`, `Bash(sh *)`, `Bash(docker exec *)`: those allow arbitrary code.
- Rules match the text **as written**: `Bash(git push *)` does not match `git -C /repo push`, `/usr/bin/git push` or `sh -c 'git push'`. Write the rule for the form actually used.
- Compound commands (`a && b`, pipes) need a rule per part. Leading `VAR=value` and `timeout`/`nice`/`nohup` wrappers are stripped before matching; `npx`, `docker exec`, `devbox run` are not.
- Interpreters: allow a fixed script (`Bash(node scripts/check.mjs *)`), never inline code (`node -e`, `python -c`, heredocs): those get an exact rule or a one-time approval.
- Files: `Edit(/src/app.ts)` (leading `/` = project root in project settings), `Read(//etc/hosts)` (`//` = absolute), `Read(~/notes/**)`. Write and NotebookEdit are governed by `Edit(...)` rules.
- Web: `WebFetch(domain:docs.example.com)`; subdomains need `WebFetch(domain:*.example.com)`. MCP: `mcp__<server>__<tool>`.
- Destructive or production commands (`rm -rf`, force push, `vercel --prod`, `terraform apply`, a push to `main`): recommend approving each time, or an `ask` rule, not an allow rule.
- Project settings only: `<project>/.claude/settings.json` (shared) or `.claude/settings.local.json` (just this user). Never `~/.claude/settings.json` for a project's needs.

## Auto mode classifier

- A narrow project allow rule (like the ones above) is resolved before the classifier, so it lets that exact action through. Broad rules (`Bash(*)`, interpreter wildcards) are suspended in auto mode, and `autoMode.classifyAllShell: true` suspends all shell allow rules.
- One-off action the user really intended: tell them what was blocked and why (the `[Rule Name]` in brackets); if they confirm in their own words, retry once. `/permissions` > **Recently denied** > `r` also retries it.
- Recurring trusted destination (their GitHub org, an internal domain, a bucket): that belongs in `autoMode.environment`, which the classifier reads **only** from `~/.claude/settings.json` or managed settings, never from project files. Show them the entry; it is their decision to add it.

## Never

- Never retry the same thing in a different spelling to slip past a rule (`sh -c`, a full path, a script that does it). That is circumventing the user's control.
- Never suggest `bypassPermissions`, `--dangerously-skip-permissions`, `Bash(*)` or turning auto mode off to "make it work".
- Never add a rule after the user said no.
