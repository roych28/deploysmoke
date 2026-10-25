#!/usr/bin/env node
// deploysmoke / prove-its-live
//
// Print the commit production actually serves next to the commit you expected, and say whether they match.
// "Pushed is not deployed, deployed is not live."
//
//   node served-sha.mjs [--repo <path>] [--ref <git ref>] [--no-fetch] [source] [--tag [--push-tag]] [--json]
//
// Source of the served SHA (pick one; default is --vercel when <repo>/.vercel/project.json exists):
//   --vercel [--project <id|name>] [--team <teamId|slug>]   ask the Vercel API which deployment the production domains serve
//   --url <https://site/version.json>                       read the SHA your build exposes at an endpoint
//   --sha <sha>                                             a served SHA you read elsewhere (Netlify, Render, Fly, Pages...)
//
// Expected commit: --ref (default origin/<default branch>, or HEAD when there is no origin remote).
// Tagging (opt-in): --tag moves the local `production` tag to the served SHA; --push-tag also force-pushes that tag.
// Vercel auth: VERCEL_TOKEN, else the Vercel CLI's own login file. The token is read in-process and never printed.
//
// Exit codes: 0 match, 1 mismatch or unverifiable, 2 usage or runtime error.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compare, describeVercelDeployment, extractSha, newerUnservedAttempts, servedFromVercelProject, short } from './lib.mjs';

const USAGE = 'usage: node served-sha.mjs [--repo <path>] [--ref <ref>] [--no-fetch] [--vercel [--project <id>] [--team <id>] | --url <url> | --sha <sha>] [--tag [--push-tag]] [--json]';
const API = process.env.DEPLOYSMOKE_VERCEL_API || 'https://api.vercel.com';

function parseArgs(argv) {
  const o = { repo: process.cwd(), ref: null, fetch: true, source: null, project: null, team: null, url: null, sha: null, tag: false, pushTag: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--repo') o.repo = path.resolve(next());
    else if (a === '--ref') o.ref = next();
    else if (a === '--no-fetch') o.fetch = false;
    else if (a === '--vercel') o.source = 'vercel';
    else if (a === '--project') { o.project = next(); o.source = 'vercel'; }
    else if (a === '--team') o.team = next();
    else if (a === '--url') { o.url = next(); o.source = 'url'; }
    else if (a === '--sha') { o.sha = next().trim().toLowerCase(); o.source = 'sha'; }
    else if (a === '--tag') o.tag = true;
    else if (a === '--push-tag') { o.tag = true; o.pushTag = true; }
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (repo, ...args) => { try { git(repo, ...args); return true; } catch { return false; } };

function vercelToken() {
  if (process.env.VERCEL_TOKEN?.trim()) return process.env.VERCEL_TOKEN.trim();
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'com.vercel.cli', 'auth.json'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'com.vercel.cli', 'Data', 'auth.json') : null,
  ].filter(Boolean);
  for (const f of candidates) {
    try { const t = JSON.parse(fs.readFileSync(f, 'utf8')).token; if (t) return t; } catch { /* next */ }
  }
  throw new Error('no Vercel token: run `vercel login`, or set VERCEL_TOKEN in the environment (never paste it into chat)');
}

async function vercelGet(urlPath, token) {
  const res = await fetch(`${API}${urlPath}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 401 ? ' (token expired or wrong team: run `vercel login`, or pass --team)' : '';
    throw new Error(`Vercel API ${res.status}${hint}: ${body.slice(0, 160)}`);
  }
  return JSON.parse(body);
}

async function servedFromVercel(o) {
  let projectId = o.project, teamId = o.team;
  const linked = path.join(o.repo, '.vercel', 'project.json');
  if (!projectId && fs.existsSync(linked)) {
    const pj = JSON.parse(fs.readFileSync(linked, 'utf8'));
    projectId = pj.projectId;
    if (!teamId && pj.orgId?.startsWith('team_')) teamId = pj.orgId;
  }
  if (!projectId) throw new Error('no Vercel project: run `vercel link` in the repo, or pass --project <id|name> [--team <id|slug>]');
  const token = vercelToken();
  const q = teamId ? (teamId.startsWith('team_') ? `teamId=${encodeURIComponent(teamId)}` : `slug=${encodeURIComponent(teamId)}`) : '';
  const project = await vercelGet(`/v9/projects/${encodeURIComponent(projectId)}${q ? `?${q}` : ''}`, token);
  let served = servedFromVercelProject(project);
  const recent = await vercelGet(`/v6/deployments?projectId=${encodeURIComponent(project.id || projectId)}&target=production&limit=10${q ? `&${q}` : ''}`, token);
  if (!served) {
    const ready = (recent.deployments || []).find((d) => (d.readyState || d.state) === 'READY');
    if (!ready) throw new Error('no READY production deployment found');
    served = describeVercelDeployment(ready);
  }
  return { served, notes: newerUnservedAttempts(recent.deployments, served), label: `Vercel project ${project.name || projectId}` };
}

function resolveExpected(o) {
  if (!gitOk(o.repo, 'rev-parse', '--git-dir')) throw new Error(`not a git repository: ${o.repo}`);
  const hasOrigin = gitOk(o.repo, 'remote', 'get-url', 'origin');
  if (hasOrigin && o.fetch) { try { git(o.repo, 'fetch', '-q', 'origin'); } catch (e) { console.error(`warning: git fetch failed, comparing against the last fetched state (${String(e.message).split('\n')[0]})`); } }
  let ref = o.ref;
  if (!ref) {
    if (hasOrigin) {
      let head = null;
      try { head = git(o.repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'); } catch { /* not set */ }
      ref = head || (gitOk(o.repo, 'rev-parse', '--verify', '-q', 'origin/main') ? 'origin/main' : 'origin/master');
    } else ref = 'HEAD';
  }
  return { ref, sha: git(o.repo, 'rev-parse', `${ref}^{commit}`).toLowerCase(), hasOrigin };
}

function relationOf(repo, served, expected) {
  if (!gitOk(repo, 'cat-file', '-e', `${served}^{commit}`)) return { relation: 'unknown', full: served };
  const full = git(repo, 'rev-parse', `${served}^{commit}`).toLowerCase();
  if (full === expected) return { relation: 'same', full };
  if (gitOk(repo, 'merge-base', '--is-ancestor', full, expected)) return { relation: 'behind', full };
  if (gitOk(repo, 'merge-base', '--is-ancestor', expected, full)) return { relation: 'ahead', full };
  return { relation: 'diverged', full };
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  if (!o.source) o.source = fs.existsSync(path.join(o.repo, '.vercel', 'project.json')) ? 'vercel' : null;
  if (!o.source) { console.error(`no source for the served SHA: pass --vercel, --url or --sha\n${USAGE}`); process.exit(2); }

  const expected = resolveExpected(o);
  let served = null, notes = [], label = '';
  if (o.source === 'vercel') ({ served, notes, label } = await servedFromVercel(o));
  else if (o.source === 'url') {
    const res = await fetch(o.url, { headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`${o.url} answered ${res.status}`);
    served = { sha: extractSha(await res.text()), url: o.url };
    label = o.url;
  } else { served = { sha: o.sha }; label = '--sha'; }

  let rel = { relation: null, full: served.sha };
  if (served.sha) rel = relationOf(o.repo, served.sha, expected.sha);
  const result = compare({ served: rel.full, expected: expected.sha, relation: rel.relation });
  const subject = (sha) => { try { return git(o.repo, 'log', '-1', '--format=%s', sha); } catch { return '(commit not in this clone)'; } };

  const out = {
    verdict: result.verdict, relation: result.relation || null, message: result.message, source: label,
    served: { sha: rel.full || null, subject: rel.full ? subject(rel.full) : null, url: served.url || null, createdAt: served.createdAt ? new Date(served.createdAt).toISOString() : null, actor: served.actor || null },
    expected: { ref: expected.ref, sha: expected.sha, subject: subject(expected.sha) },
    notDeployed: notes.map((n) => ({ state: n.state, sha: n.sha, url: n.url, createdAt: new Date(n.createdAt).toISOString() })),
    tagged: null,
  };
  if (!expected.hasOrigin && !o.ref) out.warning = 'this repo has no origin remote: compared against local HEAD, which proves nothing about what was pushed';

  if (o.tag) {
    if (result.verdict === 'unverifiable' || !rel.full || rel.relation === 'unknown') out.tagged = 'skipped: no served commit in this clone to tag';
    else {
      git(o.repo, 'tag', '-f', '-a', 'production', '-m', `production serves ${short(rel.full)} (${label})`, rel.full);
      out.tagged = `production -> ${short(rel.full)}`;
      if (o.pushTag) { git(o.repo, 'push', '-q', '-f', 'origin', 'refs/tags/production'); out.tagged += ' (pushed)'; }
    }
  }

  if (o.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`source    : ${label}`);
    console.log(`served    : ${short(out.served.sha)}  ${out.served.subject || ''}${out.served.url ? `  ${out.served.url}` : ''}${out.served.createdAt ? `  since ${out.served.createdAt}` : ''}`);
    console.log(`expected  : ${short(expected.sha)}  ${out.expected.subject}  (${expected.ref})`);
    for (const n of out.notDeployed) console.log(`not live  : ${n.state} ${short(n.sha)} ${n.url || ''} at ${n.createdAt}`);
    console.log(`verdict   : ${out.verdict.toUpperCase()}${out.relation && out.relation !== 'same' ? ` (${out.relation})` : ''}`);
    console.log(`            ${out.message}`);
    if (out.warning) console.log(`warning   : ${out.warning}`);
    if (out.tagged) console.log(`tag       : ${out.tagged}`);
  }
  process.exit(result.verdict === 'match' ? 0 : 1);
}

main().catch((e) => { console.error(`prove-its-live: ${e.message}`); process.exit(2); });
