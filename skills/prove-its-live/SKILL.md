---
name: prove-its-live
description: Before claiming anything is "deployed", "live", "shipped", "in prod" or "fixed in production", prove it - read which commit production actually serves (Vercel API through the CLI's own login, a /version or build-id endpoint, Netlify, Render, Fly, Cloudflare or GitHub Pages) and compare it to what you pushed; optionally move a `production` git tag. Use after every push or deploy, whenever someone asks "is it live?", "what's in production?", "did the deploy go out?", "is my fix up?", and before writing a status update or closing a ticket about production.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/served-sha.mjs *)
---

# Prove it's live

**Pushed is not deployed. Deployed is not live.** `git push` printing success says nothing about which
commit your users get. Real failures: the push succeeded but landed on another session's branch, so nothing
deployed; the build failed silently and the old version kept serving; a rollback was promoted and nobody knew.

Every sentence you write about production must rest on evidence read **in this session**: the SHA the
platform serves, compared with the SHA you expected. Otherwise write "not verified".

## The check

```bash
node ${CLAUDE_SKILL_DIR}/served-sha.mjs --repo /full/path/to/repo
```

`${CLAUDE_SKILL_DIR}` is this skill's folder. Output, for example:

```
served    : 6c7f852  Product page        https://site-abc.vercel.app  since 2026-10-25T16:03:13Z
expected  : 8f95ca4  Launch posts        (origin/main)
not live  : ERROR 8f95ca4 https://site-def.vercel.app at 2026-10-25T16:10:02Z
verdict   : MISMATCH (behind)
```

Exit 0 = MATCH. Exit 1 = MISMATCH or UNVERIFIABLE. Exit 2 = it could not run (say so; do not guess).

| Flag | Meaning |
|---|---|
| `--vercel` | default when the repo has `.vercel/project.json`. Reads the deployment the production domains serve (`targets.production`), not just the newest build, so rollbacks show up. Lists newer production deploys that failed or are still building |
| `--project <id\|name> --team <teamId\|slug>` | when the repo is not linked |
| `--url https://site/version.json` | read the SHA your build exposes (JSON field `sha`, `commit`, `gitSha`, `buildId`... or any 40-hex string) |
| `--sha <sha>` | a served SHA you read from another platform (below) |
| `--ref <ref>` | what you expected to be live (default `origin/<default branch>`, after `git fetch`) |
| `--tag` / `--push-tag` | move the `production` tag to the served commit locally / and push it, so `git log --decorate` shows what is up |

Vercel auth comes from `VERCEL_TOKEN` or the Vercel CLI's own login file (`vercel login`); it is read
in-process and never printed. Never ask the user to paste a token into the chat.

## Verdicts and what to do

| Verdict | Means | Do |
|---|---|---|
| MATCH | production serves exactly the expected commit | now run `post-deploy-smoke` on the live URLs; only then say "live" |
| MISMATCH (behind) | your commit is not live | check the build log / the `not live` line; wait or fix; re-check |
| MISMATCH (ahead) | something newer than your ref is live | someone else deployed; fetch and read before saying anything |
| MISMATCH (diverged / unknown) | another branch, or a commit not in your clone | find out who deployed what |
| UNVERIFIABLE | the deployment has no commit SHA (CLI upload without git metadata) | deploy from git, or add a `/version` endpoint, then check with `--url` |

## Other platforms: get the served SHA, pass it with `--sha`

Verify field names against your provider's current API docs; these are the usual places.

- **Any platform**: expose the build commit at a URL (e.g. write `VERCEL_GIT_COMMIT_SHA`, `COMMIT_REF`, `RENDER_GIT_COMMIT`, `GITHUB_SHA` into `/version.json` at build time) and use `--url`. Most reliable, because it is what the live server actually returns.
- **Netlify**: `netlify api listSiteDeploys --data '{"site_id":"<id>"}'`; the published deploy's `commit_ref`.
- **Render**: `GET https://api.render.com/v1/services/<id>/deploys?limit=1`; `commit.id` of the live deploy.
- **Fly.io**: `fly releases --json` / `fly image show` shows the image; tag images with the git SHA at build so it is readable.
- **Cloudflare Pages**: `wrangler pages deployment list --project-name <name>`; the production deployment's source commit.
- **GitHub Pages**: `gh api repos/<owner>/<repo>/pages/builds/latest --jq .commit`.
- **Your remote, not a platform**: `git ls-remote origin refs/heads/<branch>` proves what was pushed, not what is deployed.

## Rules

- Never write "deployed", "live" or "fixed in prod" from a push message, a CI badge, a dashboard you did not read in this session, or memory.
- Compare against the remote (`origin/<branch>` after fetch), not your local HEAD; the script warns when there is no remote.
- A MATCH proves the code; it does not prove the page works. Follow with `post-deploy-smoke`.
- `--tag`/`--push-tag` only on repos you own and only when asked; the tag must point at what is served, never at what you hope is served.
- Report in one line: served SHA, expected SHA, verdict, and the live URL.
