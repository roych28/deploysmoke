#!/usr/bin/env node
// deploysmoke / multi-session-git: git checks for repos that several agent sessions (or people) share.
//
//   node git-guard.mjs preflight   --repo <path> [--branch <expected>]
//       Before a commit: which branch is HEAD on, is it the one you expect, is it detached, what is
//       staged/modified, which worktrees exist, how far from upstream. Exit 1 when HEAD is not the
//       expected branch or is detached.
//
//   node git-guard.mjs verify-push --repo <path> [--branch <name>] [--commit <sha>] [--remote origin]
//       After a push: is <commit> (default HEAD) actually contained in <remote>/<branch> on the server
//       (read with git ls-remote, not from the local tracking ref)? Exit 1 when it is not.
//
// Exit codes: 0 ok, 1 problem found, 2 usage or git error.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ok = (repo, ...a) => { try { git(repo, ...a); return true; } catch { return false; } };

function parse(argv) {
  const o = { cmd: argv[0], repo: process.cwd(), branch: null, commit: 'HEAD', remote: 'origin', json: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--repo') o.repo = path.resolve(v());
    else if (a === '--branch') o.branch = v();
    else if (a === '--commit') o.commit = v();
    else if (a === '--remote') o.remote = v();
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['preflight', 'verify-push'].includes(o.cmd)) throw new Error('first argument must be preflight or verify-push');
  return o;
}

function preflight(o) {
  const head = ok(o.repo, 'symbolic-ref', '-q', '--short', 'HEAD') ? git(o.repo, 'symbolic-ref', '--short', 'HEAD') : null;
  const sha = git(o.repo, 'rev-parse', '--short', 'HEAD');
  const status = git(o.repo, 'status', '--porcelain=v1').split('\n').filter(Boolean);
  const staged = status.filter((l) => l[0] !== ' ' && l[0] !== '?').map((l) => l.slice(3));
  const unstaged = status.filter((l) => l[1] !== ' ' && l[0] !== '?').map((l) => l.slice(3));
  const untracked = status.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  const worktrees = git(o.repo, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map((b) => {
    const wt = Object.fromEntries(b.split('\n').map((l) => { const [k, ...r] = l.split(' '); return [k, r.join(' ') || true]; }));
    return { path: wt.worktree, branch: wt.branch ? wt.branch.replace('refs/heads/', '') : '(detached)' };
  });
  let upstream = null, ahead = null, behind = null;
  if (head && ok(o.repo, 'rev-parse', '--abbrev-ref', '@{u}')) {
    upstream = git(o.repo, 'rev-parse', '--abbrev-ref', '@{u}');
    [behind, ahead] = git(o.repo, 'rev-list', '--left-right', '--count', '@{u}...HEAD').split(/\s+/).map(Number);
  }
  const problems = [];
  if (!head) problems.push('HEAD is detached: a commit here belongs to no branch. Create or switch to your own branch first.');
  if (o.branch && head && head !== o.branch) problems.push(`HEAD is on "${head}", not "${o.branch}". Another session may have switched branches in this folder. Do not commit here and do not checkout: use your own worktree.`);
  const top = git(o.repo, 'rev-parse', '--show-toplevel');
  const elsewhere = o.branch ? worktrees.find((w) => w.branch === o.branch && path.resolve(w.path) !== path.resolve(top)) : null;
  if (elsewhere) problems.push(`"${o.branch}" is checked out in another worktree: ${elsewhere.path}. Commit there, or make your own branch.`);
  return { ok: problems.length === 0, repo: top, branch: head, sha, expected: o.branch, upstream, ahead, behind, staged, unstaged, untracked, worktrees, problems };
}

function verifyPush(o) {
  const commit = git(o.repo, 'rev-parse', `${o.commit}^{commit}`);
  const current = ok(o.repo, 'symbolic-ref', '-q', '--short', 'HEAD') ? git(o.repo, 'symbolic-ref', '--short', 'HEAD') : null;
  const branch = o.branch || current;
  if (!branch) throw new Error('detached HEAD: pass --branch <name>');
  const line = git(o.repo, 'ls-remote', o.remote, `refs/heads/${branch}`);
  const remoteSha = line ? line.split(/\s+/)[0] : null;
  const problems = [];
  let contained = false;
  if (!remoteSha) problems.push(`${o.remote} has no branch "${branch}". The push did not happen or went to another name.`);
  else {
    if (!ok(o.repo, 'cat-file', '-e', `${remoteSha}^{commit}`)) git(o.repo, 'fetch', '-q', o.remote, branch);
    contained = remoteSha === commit || ok(o.repo, 'merge-base', '--is-ancestor', commit, remoteSha);
    if (!contained) {
      problems.push(`your commit ${commit.slice(0, 7)} is NOT on ${o.remote}/${branch} (the server has ${remoteSha.slice(0, 7)}).`);
      if (current && current !== branch) problems.push(`HEAD is on "${current}", not "${branch}": the commit landed on another branch, so pushing "${branch}" pushed nothing.`);
    }
  }
  const subject = (s) => { try { return git(o.repo, 'log', '-1', '--format=%h %s (%an, %cr)', s); } catch { return s?.slice(0, 7) || null; } };
  return { ok: problems.length === 0, commit: subject(commit), remote: `${o.remote}/${branch}`, remoteHead: remoteSha ? subject(remoteSha) : null, problems };
}

function print(cmd, r) {
  if (cmd === 'preflight') {
    console.log(`repo      : ${r.repo}`);
    console.log(`branch    : ${r.branch || '(detached)'} @ ${r.sha}${r.expected ? `   expected: ${r.expected}` : ''}`);
    if (r.upstream) console.log(`upstream  : ${r.upstream}  ahead ${r.ahead}, behind ${r.behind}`);
    console.log(`staged    : ${r.staged.length ? r.staged.slice(0, 20).join(', ') : '(nothing)'}`);
    if (r.unstaged.length) console.log(`modified  : ${r.unstaged.slice(0, 20).join(', ')}  <- not yours? leave them alone`);
    if (r.untracked.length) console.log(`untracked : ${r.untracked.length} file(s)`);
    for (const w of r.worktrees) console.log(`worktree  : ${w.branch.padEnd(24)} ${w.path}`);
  } else {
    console.log(`commit    : ${r.commit}`);
    console.log(`remote    : ${r.remote} -> ${r.remoteHead || '(missing)'}`);
  }
  for (const p of r.problems) console.log(`PROBLEM   : ${p}`);
  console.log(r.ok ? 'ok' : 'NOT OK');
}

try {
  const o = parse(process.argv.slice(2));
  const r = o.cmd === 'preflight' ? preflight(o) : verifyPush(o);
  if (o.json) console.log(JSON.stringify(r, null, 2)); else print(o.cmd, r);
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(`git-guard: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  console.error('usage: node git-guard.mjs preflight|verify-push --repo <path> [--branch <name>] [--commit <sha>] [--remote origin] [--json]');
  process.exit(2);
}
