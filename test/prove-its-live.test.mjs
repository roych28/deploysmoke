// prove-its-live: comparison logic with fixtures, then the CLI end to end against a temp git repo
// and a mock Vercel API. No real deploys, no real tags: the only tag moved is in a throwaway repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { compare, extractSha, servedFromVercelProject, newerUnservedAttempts } from '../skills/prove-its-live/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'skills/prove-its-live/served-sha.mjs');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures', n), 'utf8'));
const run = promisify(execFile);

test('servedFromVercelProject reads the commit the production domains serve', () => {
  const s = servedFromVercelProject(fixture('vercel-project-git.json'));
  assert.equal(s.sha, '1111111111111111111111111111111111111111');
  assert.equal(s.ref, 'main');
  assert.deepEqual(s.aliases, ['fixture-site.vercel.app']);
});

test('a CLI deploy without git metadata is unverifiable, never a match', () => {
  const s = servedFromVercelProject(fixture('vercel-project-cli.json'));
  assert.equal(s.sha, null);
  assert.equal(compare({ served: s.sha, expected: 'a'.repeat(40) }).verdict, 'unverifiable');
});

test('newer production deploys that failed are surfaced', () => {
  const served = servedFromVercelProject(fixture('vercel-project-git.json'));
  const notes = newerUnservedAttempts(fixture('vercel-deployments.json').deployments, served);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].state, 'ERROR');
  assert.equal(notes[0].sha, '2'.repeat(40));
});

test('compare: same, behind, ahead, diverged, unknown', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.equal(compare({ served: a, expected: a }).verdict, 'match');
  assert.equal(compare({ served: 'aaaaaaa', expected: a }).verdict, 'match');
  for (const relation of ['behind', 'ahead', 'diverged', 'unknown']) {
    const r = compare({ served: a, expected: b, relation });
    assert.equal(r.verdict, 'mismatch');
    assert.equal(r.relation, relation);
  }
  assert.match(compare({ served: a, expected: b, relation: 'behind' }).message, /BEHIND/);
});

test('extractSha reads common /version endpoint shapes', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  assert.equal(extractSha(JSON.stringify({ sha })), sha);
  assert.equal(extractSha(JSON.stringify({ build: { commit: sha } })), sha);
  assert.equal(extractSha(`build ${sha} ok`), sha);
  assert.equal(extractSha('{"version":"1.2.3"}'), null);
});

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploysmoke-pil-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1'); g('add', 'a.txt'); g('commit', '-q', '-m', 'first: deployed');
  const first = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), '2'); g('add', 'a.txt'); g('commit', '-q', '-m', 'second: pushed, not deployed');
  return { dir, g, first, second: g('rev-parse', 'HEAD') };
}

async function cli(args, env = {}) {
  try { const { stdout } = await run(process.execPath, [CLI, ...args, '--json'], { env: { ...process.env, ...env } }); return { code: 0, out: JSON.parse(stdout) }; }
  catch (e) { if (e.code === 2) throw new Error(e.stderr); return { code: e.code, out: JSON.parse(e.stdout) }; }
}

test('CLI: served != local prints MISMATCH (behind) and exits 1; equal exits 0', async () => {
  const r = tempRepo();
  const bad = await cli(['--repo', r.dir, '--ref', 'HEAD', '--no-fetch', '--sha', r.first]);
  assert.equal(bad.code, 1);
  assert.equal(bad.out.verdict, 'mismatch');
  assert.equal(bad.out.relation, 'behind');
  assert.equal(bad.out.served.subject, 'first: deployed');
  const good = await cli(['--repo', r.dir, '--ref', 'HEAD', '--no-fetch', '--sha', r.second]);
  assert.equal(good.code, 0);
  assert.equal(good.out.verdict, 'match');
});

test('CLI: --tag moves `production` only in the given repo, to the served commit', async () => {
  const r = tempRepo();
  const res = await cli(['--repo', r.dir, '--ref', 'HEAD', '--no-fetch', '--sha', r.first, '--tag']);
  assert.equal(res.code, 1);
  assert.equal(r.g('rev-parse', 'production^{commit}'), r.first);
});

test('CLI: --vercel against a mock API reads targets.production and reports a failed newer deploy', async () => {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.vercel'));
  fs.writeFileSync(path.join(r.dir, '.vercel/project.json'), JSON.stringify({ projectId: 'prj_fixture', orgId: 'team_fixture' }));
  const project = fixture('vercel-project-git.json');
  project.targets.production.meta.githubCommitSha = r.first;
  const deployments = fixture('vercel-deployments.json');
  deployments.deployments[0].meta.githubCommitSha = r.second;
  deployments.deployments[1].meta.githubCommitSha = r.first;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v9/projects/prj_fixture?teamId=team_fixture')) return res.end(JSON.stringify(project));
    if (req.url.startsWith('/v6/deployments?projectId=prj_fixture')) return res.end(JSON.stringify(deployments));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await cli(['--repo', r.dir, '--ref', 'HEAD', '--no-fetch'], { DEPLOYSMOKE_VERCEL_API: `http://127.0.0.1:${server.address().port}`, VERCEL_TOKEN: 'fixture-token' });
    assert.equal(res.code, 1);
    assert.equal(res.out.verdict, 'mismatch');
    assert.equal(res.out.relation, 'behind');
    assert.equal(res.out.served.sha, r.first);
    assert.equal(res.out.notDeployed.length, 1);
    assert.equal(res.out.notDeployed[0].state, 'ERROR');
    assert.ok(seen.every((s) => s.auth === 'Bearer fixture-token'));
    assert.ok(!JSON.stringify(res.out).includes('fixture-token'), 'the token must never be printed');
  } finally { server.close(); }
});
