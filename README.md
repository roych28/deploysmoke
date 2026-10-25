# deploysmoke

**Skills for Claude Code that stop your agent from breaking production.**

Your agent writes the code, pushes it, and says "deployed, all good". deploysmoke makes it prove that:
in a real browser, on the live URL, against the commit that is actually being served, without a secret in
the diff and without trampling the session next door.

Five free skills, MIT licensed. Each one ships a small, dependency-light script and a test that proves it
catches the failure it exists for.

| Skill | Catches |
|---|---|
| **post-deploy-smoke** | Opens every changed page on the **live** URL in clean Chromium (1440) and WebKit/Safari (390). Fails on any 4xx/5xx asset, JS errors, images that loaded but never decoded or sit at `opacity: 0`, reveal-on-scroll content that never revealed, buttons cut off at the phone edge, sideways scroll. |
| **prove-its-live** | Never "it's live" without evidence. Reads the commit production actually serves (Vercel API via your CLI login, a `/version` endpoint, or any platform's SHA) and compares it with what you pushed: match, behind, ahead, diverged, or unverifiable. Flags newer deploys that failed. Can move a `production` git tag. |
| **multi-session-git** | Parallel sessions in one repo. Checks the real branch before every commit, sends you to your own worktree instead of `checkout`, stages explicit files only, and verifies on the server that your commit landed after every push. |
| **secret-guard** | Offline scan of the staged diff, a push range, files or command output for AWS, Stripe live, GitHub, OpenAI, Anthropic, Slack, Google and npm keys, private keys, URLs with passwords, `.env` files and high-entropy secret assignments. Findings are always masked. Optional pre-commit hook. |
| **permission-unblock** | When a tool call is refused, names the gate (missing allow rule, your own "no", a deny rule, a hook, or the auto-mode classifier) and prints the narrowest rule for the project's `.claude/settings.json`, in the current permission syntax. Or tells you why no rule should be added. |

## Install

**As a Claude Code plugin** (all five skills, updates through the marketplace):

```
/plugin marketplace add roych28/deploysmoke
/plugin install deploysmoke@deploysmoke
```

Skills then appear as `/deploysmoke:post-deploy-smoke`, `/deploysmoke:prove-its-live`, and so on, and Claude
uses them on its own when the situation matches.

**With the skills CLI** ([skills.sh](https://skills.sh), works with Claude Code and other agents):

```
npx skills add roych28/deploysmoke
```

**Browsers for the smoke test** (once per machine, in the project you check or anywhere):

```
npm install --save-dev playwright
npx playwright install chromium webkit
```

The other four skills need only Node 18+ and git. If Playwright is missing, the smoke test exits with a clear
message instead of pretending it passed.

## Why

Every skill here comes from a production incident that a green build did not catch:

- **The push succeeded but nothing deployed.** Another session had switched the shared folder to its branch.
  The commit landed there, `git push origin main` printed success and pushed nothing, and the agent reported
  "live in production".
- **Every image returned 200 and none was visible.** New HTML shipped next to a cached old script, the script
  threw, and every image stayed at `opacity: 0`. `curl` was happy. Users saw a blank page.
- **"Fixed" on desktop, broken on every phone.** The button was half off-screen at 390px. Nobody opened Safari.
- **The deploy failed and the old version kept serving.** The dashboard said "deployed" because the previous
  deployment was still ready. Nobody compared SHAs.
- **A key in the diff.** One `git add -A` swept a `.env` into a public repo. Deleting it in the next commit
  does not un-leak it.
- **"Allow everything" because a prompt was annoying.** The real refusal came from a hook, which no allow rule
  could fix, and the broad rule stayed forever.

The rule behind all of them: **pushed is not deployed, deployed is not live, and 200 from the server is not
"the image is visible".**

## Try it on the broken site

`examples/broken-site` plants five bugs (a 404 image, a JS error, an image that returns 200 but does not
decode, a reveal block that never reveals, a CTA cut off at 390px). `examples/fixed-site` is the fixed copy.

```
git clone https://github.com/roych28/deploysmoke && cd deploysmoke
npm install && npx playwright install chromium webkit
npx serve examples -l 5173
node skills/post-deploy-smoke/smoke.mjs http://localhost:5173/broken-site/
node skills/post-deploy-smoke/smoke.mjs http://localhost:5173/fixed-site/
npm test
```

## Repository layout

```
.claude-plugin/marketplace.json   marketplace "deploysmoke" with one plugin at the repo root
.claude-plugin/plugin.json        plugin manifest
skills/<name>/SKILL.md            one folder per skill, with its script next to it
examples/                         broken-site and fixed-site fixtures
test/                             node:test suites for every skill (npm test)
```

## Pro

The free skills catch the failures. **deploysmoke Pro** stops them from shipping at all:

- **layout-audit**: every page at every width from 360 to 1920 in Chrome and Safari, buttons too close,
  too small, overlapping, half on a card, outside their column, text cut, with a screenshot per finding.
- **deploy-gate**: a hook that blocks production deploy commands until the smoke test, the SHA check and the
  secret scan have passed in this session.
- **migrations-before-deploy**: refuses to deploy code that needs a database migration that has not run in
  production yet, and runs it in the right order.
- **rollback-ready**: records the last good deployment before every deploy and gives you a one-command,
  verified rollback.
- **bug-to-regression-test**: turns every bug found in production into a permanent automated test that fails
  on the old version and passes on the fix.

[Get deploysmoke Pro](https://deploysmoke.vercel.app/#pro)

## License

MIT, see [LICENSE](LICENSE). Built for Claude Code. Not affiliated with or endorsed by Anthropic.
