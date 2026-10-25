---
name: secret-guard
description: Keep secrets out of commits, pushes, logs and the chat. Scan the staged diff (or a push range, files, or command output) for API keys and credentials - AWS, Stripe live keys, GitHub, OpenAI, Anthropic, Slack, Google, npm, private keys, database URLs with passwords, .env files, high-entropy secret assignments - refuse when one is found, and print every finding masked. Use before every `git commit` and `git push`, before printing env vars, config files or command output that may contain credentials, when the user pastes or asks for a key, and when they say "check for secrets", "did I commit a key", "is this safe to push", "install a pre-commit hook".
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scan-secrets.mjs *)
---

# Secret guard

A secret that reaches a commit, a pushed branch, a CI log or a chat transcript is leaked, even if the next
commit deletes it. The only fix after that is rotation. So the check runs **before**, and nothing you print
ever shows a full secret.

## Before every commit and push

```bash
node ${CLAUDE_SKILL_DIR}/scan-secrets.mjs --staged --repo /full/path/to/repo
node ${CLAUDE_SKILL_DIR}/scan-secrets.mjs --diff origin/main..HEAD --repo /full/path/to/repo
```

`${CLAUDE_SKILL_DIR}` is this skill's folder. Exit 0 = clean, 1 = possible secrets (findings are masked,
e.g. `API_TOKEN=Q3v9******** (19 chars)`), 2 = could not run (then do not commit; say it was not checked).

On exit 1: **stop**. Do not commit, do not push, do not "commit now and clean up later".
1. Tell the user which file and line, using the masked output only.
2. Move the value to an environment variable or a gitignored file (`.env` in `.gitignore`), read it at runtime.
3. Unstage: `git restore --staged <file>`.
4. If it was ever committed, pushed, logged or pasted anywhere: say it must be **rotated** at the provider. Rewriting history does not un-leak it.

False positive (test fixture, documented example): add a comment containing `secret-guard:allow` on that line,
or a path glob to `.secretguardignore` at the repo root. Say that you did, and why.

## Install the hook (optional, recommended)

```bash
node ${CLAUDE_SKILL_DIR}/install-hook.mjs --repo /full/path/to/repo
```

Writes a `pre-commit` hook (respects `core.hooksPath`) and copies the scanner next to it, so the hook keeps
working after this plugin updates or moves. It will not replace a pre-commit hook it did not write; it prints
the one line to add instead (`--force` keeps the old one as `pre-commit.bak`). Never bypass it with
`git commit --no-verify` unless the user explicitly says so for that commit.

## What it detects

AWS access key IDs and secret keys, Stripe live secret and restricted keys and webhook secrets, GitHub tokens
(classic and fine-grained), Anthropic and OpenAI API keys, Slack tokens and webhooks, Google API keys,
SendGrid and npm tokens, PEM private keys, URLs with an inline password (database, Redis, AMQP, HTTP),
high-entropy values assigned to names like `*_SECRET`, `*_TOKEN`, `API_KEY`, `PASSWORD`, and staged
`.env`, private key and credentials files. Placeholders (`your-key-here`, `${VAR}`, `xxxx`) and code
references (`process.env.API_KEY`) are not flagged. No network calls, no dependencies.

## Keep secrets out of chat and logs

- **Never print a secret to find out if it is set.** Not `echo $API_KEY`, not `cat .env`, not `env`, not `printenv`, not `vercel env pull && cat`. Check presence and shape instead:
  `node -e 'const v=process.env.API_KEY||""; console.log(v ? v.slice(0,4)+"... ("+v.length+" chars)" : "missing")'`
- **Read secrets in-process.** A script that needs a token reads it from the environment or the tool's own login file and uses it; it never prints it, never passes it as a CLI argument (visible in `ps` and shell history), never writes it to a log.
- **Mask command output that may contain secrets** before it reaches the transcript:
  `some-command 2>&1 | node ${CLAUDE_SKILL_DIR}/scan-secrets.mjs --redact`
- **Never ask the user to paste a key into the chat.** Ask them to put it in the environment, a gitignored `.env`, or the platform's secret store (`vercel env add`, `gh secret set`, `fly secrets set`), where it is entered at a prompt, not on the command line.
- If a secret does appear in the conversation or output, say so plainly and recommend rotating it.
- Scan text before you post it anywhere (an issue, a PR description, a Slack message): `node ${CLAUDE_SKILL_DIR}/scan-secrets.mjs - < draft.md`.
