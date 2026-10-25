// multi-session-git: two "sessions" share one clone; reproduce "the push succeeded but nothing was pushed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/multi-session-git/git-guard.mjs');
const guard = (...a) => { const r = spawnSync(process.execPath, [GUARD, ...a, '--json'], { encoding: 'utf8' }); return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }; };

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deploysmoke-msg-'));
  const remote = path.join(base, 'remote.git'), work = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'ignore' });
  const g = (...a) => execFileSync('git', ['-C', work, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test'); g('checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.txt'), '1\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init'); g('push', '-q', '-u', 'origin', 'main');
  return { base, work, g };
}

test('the other session switched branches: preflight refuses, verify-push proves nothing reached main', () => {
  const { work, g } = setup();
  g('checkout', '-q', '-b', 'other-session-feature'); // session B, same folder
  // session A, which believes it is on main:
  const pre = guard('preflight', '--repo', work, '--branch', 'main');
  assert.equal(pre.code, 1);
  assert.match(pre.out.problems.join(' '), /HEAD is on "other-session-feature", not "main"/);
  // session A commits anyway and pushes main: git says success, nothing moved
  fs.writeFileSync(path.join(work, 'fix.txt'), 'fix\n'); g('add', 'fix.txt'); g('commit', '-q', '-m', 'the fix');
  const push = spawnSync('git', ['-C', work, 'push', 'origin', 'main'], { encoding: 'utf8' });
  assert.equal(push.status, 0, 'git push exits 0');
  const ver = guard('verify-push', '--repo', work, '--branch', 'main');
  assert.equal(ver.code, 1);
  assert.match(ver.out.problems.join(' '), /is NOT on origin\/main/);
  assert.match(ver.out.problems.join(' '), /HEAD is on "other-session-feature"/);
});

test('verify-push: unpushed commit fails, pushed commit passes', () => {
  const { work, g } = setup();
  fs.writeFileSync(path.join(work, 'b.txt'), '2\n'); g('add', 'b.txt'); g('commit', '-q', '-m', 'second');
  assert.equal(guard('verify-push', '--repo', work).code, 1);
  g('push', '-q', 'origin', 'main');
  const r = guard('verify-push', '--repo', work);
  assert.equal(r.code, 0);
  assert.match(r.out.remoteHead, /second/);
});

test('preflight: own worktree passes; a branch checked out elsewhere is flagged', () => {
  const { base, work, g } = setup();
  const mine = path.join(base, 'wt-mine');
  g('worktree', 'add', '-q', '-b', 'my-task', mine, 'origin/main');
  const ok = guard('preflight', '--repo', mine, '--branch', 'my-task');
  assert.equal(ok.code, 0, JSON.stringify(ok.out.problems));
  assert.equal(ok.out.worktrees.length, 2);
  const clash = guard('preflight', '--repo', work, '--branch', 'my-task');
  assert.equal(clash.code, 1);
  assert.match(clash.out.problems.join(' '), /checked out in another worktree/);
});

test('preflight: detached HEAD is refused', () => {
  const { work, g } = setup();
  g('checkout', '-q', '--detach');
  const r = guard('preflight', '--repo', work);
  assert.equal(r.code, 1);
  assert.match(r.out.problems[0], /detached/);
});
