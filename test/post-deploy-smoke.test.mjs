// End-to-end: post-deploy-smoke must catch every planted bug in examples/broken-site and pass on examples/fixed-site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './static-server.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = path.join(ROOT, 'skills/post-deploy-smoke/smoke.mjs');
let srv;

before(async () => { srv = await serve(path.join(ROOT, 'examples')); });
after(() => srv.server.close());

async function smoke(url) {
  try {
    const { stdout } = await run(process.execPath, [SMOKE, url, '--json', '--wait', '800'], { cwd: ROOT, timeout: 120000 });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (e) {
    if (e.code === 3) throw new Error('Playwright or a browser is missing: run `npm install && npx playwright install chromium webkit`');
    return { code: e.code, out: JSON.parse(e.stdout) };
  }
}

const kinds = (r) => r.problems.map((p) => p.kind);
const has = (r, kind, re) => r.problems.some((p) => p.kind === kind && re.test(p.detail));

test('broken-site: every planted bug is caught in both engines', { timeout: 180000 }, async () => {
  const { code, out } = await smoke(`${srv.base}/broken-site/`);
  assert.equal(code, 1, 'exit code must be 1 when anything failed');
  assert.equal(out.ok, false);
  const chromium = out.results.find((r) => r.engine === 'chromium-1440');
  const webkit = out.results.find((r) => r.engine === 'webkit-390');
  for (const r of [chromium, webkit]) {
    assert.ok(has(r, 'http', /^404 .*img\/logo\.png/), `${r.engine}: 404 image not caught: ${kinds(r)}`);
    assert.ok(has(r, 'js-error', /initCarousel/), `${r.engine}: JS error not caught: ${kinds(r)}`);
    assert.ok(has(r, 'broken-image', /img\/product\.png/), `${r.engine}: 200-but-not-an-image not caught: ${kinds(r)}`);
    assert.ok(has(r, 'invisible-media', /img\/team\.png/), `${r.engine}: image hidden by reveal class not caught: ${kinds(r)}`);
    assert.ok(has(r, 'unrevealed', /section#team/), `${r.engine}: unrevealed block not caught: ${kinds(r)}`);
  }
  assert.ok(has(webkit, 'cut-off', /a\.cta "Book a demo"/), `webkit-390: off-screen button not caught: ${kinds(webkit)}`);
  assert.ok(has(webkit, 'sideways-scroll', /wider than the 390px/), `webkit-390: sideways scroll not caught: ${kinds(webkit)}`);
  assert.ok(!has(chromium, 'cut-off', /./), 'chromium-1440: the button is fine on desktop and must not be flagged');
});

test('fixed-site: the fixed copy passes clean', { timeout: 180000 }, async () => {
  const { code, out } = await smoke(`${srv.base}/fixed-site/`);
  assert.equal(code, 0, `fixed copy failed: ${JSON.stringify(out.results.map((r) => r.problems))}`);
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
});
