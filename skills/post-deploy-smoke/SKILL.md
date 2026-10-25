---
name: post-deploy-smoke
description: Smoke-test a deploy on the LIVE URL in real browsers (Chromium 1440 and WebKit/Safari 390) and fail on what a status code hides - 4xx/5xx on any asset, JS errors, images that loaded but are invisible or never decoded, reveal-on-scroll content still hidden, buttons cut off at the phone edge, sideways scroll. Use right after every deploy or release of a website or web app, before saying "deployed", "live", "done" or sending anyone a link, and when the user says "smoke test", "check the deploy", "is the site OK", "verify production", "post-deploy check" or "did it break anything".
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/smoke.mjs *)
---

# Post-deploy smoke test

A deploy is not finished when the build is green or `curl` returns 200. It is finished when every page you
touched loads on the **live address** in a clean browser with no JS errors and everything that should be
visible is visible. **200 from the server is not "the image is visible."**

Real failures this catches: a new HTML shipped next to a cached old `app.js`, the script threw, and every
image stayed at `opacity: 0` while the server answered 200 for all of them. A "fixed" button that was fine on
desktop and half off-screen on every phone.

## When

- After **every** production deploy, on every URL whose code, content, CSS or assets changed, for every site you touched.
- Before deploying, on the preview or local build, so the problem never ships.
- Before you write "deployed", "live", "fixed in prod", or send a link to anyone.

## Run it

Needs Node 18+ and Playwright (`npm i -D playwright && npx playwright install chromium webkit`). If Playwright
is missing the script exits 3 and says so; nothing was checked, so do not report a pass.

```bash
node ${CLAUDE_SKILL_DIR}/smoke.mjs https://example.com/ https://example.com/pricing
```

`${CLAUDE_SKILL_DIR}` is this skill's folder (the folder holding this SKILL.md). Options:

| Option | Use |
|---|---|
| `--engines chromium,webkit` | default both: Chromium 1440x900 and WebKit 390x844 as an iPhone |
| `--ignore <regex>` | skip failing third-party URLs you do not own (analytics are skipped by default) |
| `--reveal <selector>` | your own reveal-on-scroll class if it is not `.reveal`, `[data-aos]`, `.fade-in`... |
| `--wait <ms>` | settle time after load and after scrolling (default 1500) |
| `--json` | machine-readable output |

Exit 0 = every page clean in every engine. Exit 1 = something failed. Exit 2 = bad arguments. Exit 3 = Playwright or a browser missing.

## What it checks (each page, each engine, in a fresh context)

| Kind | Meaning |
|---|---|
| `http` | any response >= 400: the page, an image, a script, a font, an API call |
| `request-failed` | DNS, TLS, refused or blocked requests |
| `js-error` / `console-error` | uncaught exceptions and `console.error` |
| `broken-image` | `<img>` finished loading with `naturalWidth` 0 (404, wrong type, corrupt, HTML served as an image) |
| `invisible-media` | image or video that is rendered but has opacity 0 or `visibility: hidden` on it or a parent, after scrolling the whole page (carousel slides waiting their turn are allowed when another slide is visible) |
| `unrevealed` | reveal-on-scroll blocks still hidden after the whole page was scrolled |
| `hidden-but-shown` | element with the `hidden` attribute that CSS draws anyway |
| `dead-video` | `<video>` with no data |
| `cut-off` | link, button or field crossing the screen edge (not inside a scroll container) |
| `sideways-scroll` | the page is wider than the viewport |

## Procedure

1. List the URLs that changed (from the diff: routes, templates, shared CSS/JS means "every page type").
   Include pages nothing links to (404, legal, a product page).
2. Wait until the deploy is actually serving your commit (see the `prove-its-live` skill), then run the script on the **live** URLs.
3. For each `FAIL`: open the page yourself, find the cause in the code, fix it, deploy, and run the script again on the live URL.
4. Report per site: what was checked (pages, engines), what failed and was fixed, what remains and why, and the full live URL.

## Rules

- Never report "deployed" or "working" off a build log, a 200, or a local run. Only off this script passing on the live URL in this session.
- A pass on `localhost` or a preview URL is not a pass on production: caches, CDNs, env vars and redirects differ.
- If the script could not run (exit 3, network down), say "not verified", not "looks fine".
- Do not silence a finding with `--ignore` unless the URL is genuinely third-party and outside your control; say which ones you ignored.
- When a human finds a bug this missed, add a check for it and prove it catches the old version.
