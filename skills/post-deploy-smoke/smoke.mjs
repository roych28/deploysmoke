#!/usr/bin/env node
// deploysmoke / post-deploy-smoke
//
// Open every URL you changed on the LIVE address in clean browsers and fail on what
// a status code cannot tell you: JS errors, images that loaded but are invisible,
// reveal-on-scroll content that never revealed, buttons cut off at the screen edge.
//
//   node smoke.mjs <url...> [options]
//
// Options
//   --engines chromium,webkit   engines to run (default both: Chromium 1440x900, WebKit 390x844 iPhone)
//   --ignore <regex>            ignore failing requests whose URL matches (default: common analytics hosts)
//   --reveal <selector>         extra CSS selector for reveal-on-scroll blocks (repeatable)
//   --wait <ms>                 settle time after load and after scrolling (default 1500)
//   --timeout <ms>              navigation timeout (default 45000)
//   --json                      print machine-readable results
//
// Exit codes: 0 all pages clean, 1 something failed, 2 usage error, 3 Playwright or a browser is missing.
//
// "200 from the server is not 'the image is visible'."

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node smoke.mjs <url...> [--engines chromium,webkit] [--ignore <regex>] [--reveal <selector>] [--wait ms] [--timeout ms] [--json]';

function parseArgs(argv) {
  const o = { urls: [], engines: ['chromium', 'webkit'], ignore: null, reveal: [], wait: 1500, timeout: 45000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--engines') o.engines = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--ignore') o.ignore = new RegExp(next());
    else if (a === '--reveal') o.reveal.push(next());
    else if (a === '--wait') o.wait = Number(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.urls.push(a);
  }
  for (const e of o.engines) if (!['chromium', 'webkit', 'firefox'].includes(e)) throw new Error(`unknown engine ${e}`);
  return o;
}

// Find Playwright: DEPLOYSMOKE_PLAYWRIGHT (path to a playwright package dir), then the project you
// are standing in, then node_modules next to this script (a clone of the deploysmoke repo).
function loadPlaywright() {
  const env = process.env.DEPLOYSMOKE_PLAYWRIGHT;
  if (env) {
    try { return createRequire(path.join(process.cwd(), 'noop.js'))(path.resolve(env)); }
    catch { console.error(`deploysmoke: DEPLOYSMOKE_PLAYWRIGHT=${env} could not be loaded, trying the usual places`); }
  }
  for (const from of [path.join(process.cwd(), 'noop.js'), fileURLToPath(import.meta.url)]) {
    try { return createRequire(from)('playwright'); } catch { /* try the next location */ }
  }
  return null;
}

const DEFAULT_IGNORE = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|connect\.facebook|hotjar|clarity\.ms|segment\.(io|com)|sentry\.io\/api|vercel-insights|_vercel\/insights|_vercel\/speed-insights|plausible\.io\/api/;

const ENGINES = {
  chromium: { label: 'chromium-1440', ctx: { viewport: { width: 1440, height: 900 } } },
  webkit: {
    label: 'webkit-390',
    ctx: {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    },
  },
  firefox: { label: 'firefox-1440', ctx: { viewport: { width: 1440, height: 900 } } },
};

// Runs inside the page after the whole page was scrolled.
function inspectPage(revealSelectors) {
  const vw = window.innerWidth;
  const invisible = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (Number(s.opacity) < 0.05 || s.visibility === 'hidden') return true;
    }
    return false;
  };
  const rendered = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) d += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return text ? `${d} "${text}"` : d;
  };
  const src = (el) => el.currentSrc || el.src || el.querySelector?.('source')?.src || el.tagName.toLowerCase();
  // A carousel's waiting slides are transparent on purpose: pass when another slide in it is visible.
  const carouselHasVisible = (el) => {
    const c = el.closest('[aria-roledescription="carousel" i], .swiper, .splide, .slick-slider, .carousel');
    return !!c && [...c.querySelectorAll('img, video')].some((o) => o !== el && rendered(o) && !invisible(o));
  };
  const clipsX = (el) => {
    for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') return true;
    }
    return false;
  };

  const imgs = [...document.images].filter(rendered);
  const media = [...imgs, ...document.querySelectorAll('video')];
  const out = { images: imgs.length, problems: [] };
  const add = (kind, detail) => out.problems.push({ kind, detail });

  for (const i of imgs) if (i.complete && i.naturalWidth === 0) add('broken-image', `did not decode (naturalWidth 0): ${src(i)}`);
  for (const m of media) {
    if (!rendered(m) || m.closest('[aria-hidden="true"]')) continue;
    if (invisible(m) && !carouselHasVisible(m)) add('invisible-media', `loaded but invisible (opacity 0 or visibility hidden on it or a parent): ${src(m)}`);
  }
  for (const v of document.querySelectorAll('video')) if (rendered(v) && v.readyState === 0) add('dead-video', `video has no data: ${src(v)}`);

  const revealSel = ['.reveal', '.rv', '[data-reveal]', '[data-aos]', '.fade-in', '.animate-on-scroll', '.wow', ...revealSelectors].join(', ');
  const stuck = [...document.querySelectorAll(revealSel)].filter((e) => rendered(e) && invisible(e));
  if (stuck.length) add('unrevealed', `${stuck.length} reveal-on-scroll block(s) still hidden after scrolling the whole page: ${stuck.slice(0, 3).map(describe).join(', ')}`);

  for (const e of document.querySelectorAll('[hidden]')) {
    const r = e.getBoundingClientRect();
    if (getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0 && !invisible(e)) add('hidden-but-shown', `has the hidden attribute but is drawn (a CSS display rule beats it): ${describe(e)}`);
  }

  const interactive = document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"]');
  for (const el of interactive) {
    if (!rendered(el) || invisible(el) || el.closest('[aria-hidden="true"], [inert]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cut = (r.left < vw - 1 && r.right > vw + 1) || (r.left < -1 && r.right > 1);
    if (cut && !clipsX(el)) add('cut-off', `${describe(el)} is cut by the screen edge at ${vw}px (x ${Math.round(r.left)} to ${Math.round(r.right)})`);
  }
  const sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  if (sw > vw + 1) add('sideways-scroll', `page is ${sw - vw}px wider than the ${vw}px viewport (sideways scroll)`);
  return out;
}

async function checkUrl(browser, engine, url, opt) {
  const ctx = await browser.newContext({ ...ENGINES[engine].ctx, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const problems = [];
  const ignore = opt.ignore || DEFAULT_IGNORE;
  page.on('pageerror', (e) => problems.push({ kind: 'js-error', detail: String(e.message || e).split('\n')[0].slice(0, 200) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) return; // reported as an http status below
    problems.push({ kind: 'console-error', detail: t.split('\n')[0].slice(0, 200) });
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !ignore.test(r.url())) problems.push({ kind: 'http', detail: `${r.status()} ${r.url().slice(0, 160)}` });
  });
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText || 'failed';
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(err) || ignore.test(r.url())) return;
    problems.push({ kind: 'request-failed', detail: `${err} ${r.url().slice(0, 160)}` });
  });
  let images = 0;
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: opt.timeout });
    if (!res) problems.push({ kind: 'load', detail: 'no response' });
    await page.waitForTimeout(opt.wait);
    await page.evaluate(async () => {
      const step = Math.max(200, Math.floor(window.innerHeight * 0.6));
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await page.waitForTimeout(opt.wait);
    const r = await page.evaluate(inspectPage, opt.reveal);
    images = r.images;
    problems.push(...r.problems);
  } catch (e) {
    problems.push({ kind: 'load', detail: String(e.message || e).split('\n')[0].slice(0, 200) });
  }
  await ctx.close();
  return { engine: ENGINES[engine].label, url, images, ok: problems.length === 0, problems };
}

async function main() {
  let opt;
  try { opt = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  if (!opt.urls.length) { console.error(USAGE); process.exit(2); }
  for (const u of opt.urls) if (!/^https?:\/\//.test(u)) { console.error(`not a URL (needs http:// or https://): ${u}`); process.exit(2); }

  const pw = loadPlaywright();
  if (!pw) {
    console.error([
      'deploysmoke: Playwright is not installed, so nothing was checked.',
      'Install it in the project you are checking (or anywhere, then point DEPLOYSMOKE_PLAYWRIGHT at it):',
      '  npm install --save-dev playwright',
      '  npx playwright install chromium webkit',
      'Then run this script again.',
    ].join('\n'));
    process.exit(3);
  }

  const results = [];
  for (const engine of opt.engines) {
    let browser;
    try { browser = await pw[engine].launch(); } catch (e) {
      console.error(`deploysmoke: could not start ${engine}: ${String(e.message).split('\n')[0]}\nInstall the browser: npx playwright install ${engine}`);
      process.exit(3);
    }
    for (const url of opt.urls) results.push(await checkUrl(browser, engine, url, opt));
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (opt.json) console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  else {
    for (const r of results) {
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.engine.padEnd(13)} ${r.url}  (${r.images} images)`);
      for (const p of r.problems) console.log(`     ${p.kind.padEnd(16)} ${p.detail}`);
    }
    console.log(failed.length
      ? `\n${failed.length} of ${results.length} page checks failed. Not deployed until these are fixed and this passes on the live URL.`
      : `\nAll ${results.length} page checks passed on ${opt.engines.join(' + ')}.`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
