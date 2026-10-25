// permission-unblock: gate classification and narrowest-rule generation, checked against the documented syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGate, suggestBash, suggestOther, splitCompound } from '../skills/permission-unblock/suggest-rule.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../skills/permission-unblock/suggest-rule.mjs');

test('classifies the gate from the denial text', () => {
  assert.equal(classifyGate('Denied by auto mode classifier [Production Deploy]'), 'auto-mode-classifier');
  assert.equal(classifyGate('Blocked by classifier'), 'auto-mode-classifier');
  assert.equal(classifyGate('PreToolUse:Bash hook error: not allowed on main'), 'hook');
  assert.equal(classifyGate('Permission to use Bash with command rm -rf x has been denied by a deny rule'), 'deny-rule');
  assert.equal(classifyGate("The user doesn't want to proceed with this tool use"), 'user-declined');
  assert.equal(classifyGate('This command requires approval'), 'missing-allow-rule');
  assert.equal(classifyGate(''), 'unknown');
});

const CASES = [
  ['npm run build', ['Bash(npm run build *)']],
  ['npm test', ['Bash(npm test *)']],
  ['git -C /repo push origin feature-x', ['Bash(git -C /repo push *)']],
  ['gh pr create --title x --body y', ['Bash(gh pr create *)']],
  ['NODE_ENV=test timeout 30 npm run lint -- --fix', ['Bash(npm run lint *)']],
  ['node scripts/check.mjs --all', ['Bash(node scripts/check.mjs *)']],
  ['node -e "console.log(1)"', ['Bash(node -e "console.log(1)")']],
  ['npx playwright install chromium', ['Bash(npx playwright install *)']],
  ['docker exec web sh', ['Bash(docker exec web sh)']],
  ['rm -rf dist', ['Bash(rm -rf dist)']],
  ['git push --force origin main', ['Bash(git push --force origin main)']],
  ['git -c core.fsmonitor=x status', ['Bash(git -c core.fsmonitor=x status)']],
  ['vercel env ls production', ['Bash(vercel env ls *)']],
  ['ls -la && npm run build | tee out.log', ['Bash(npm run build *)', 'Bash(tee out.log *)']],
];

test('narrowest Bash rules', () => {
  for (const [cmd, want] of CASES) assert.deepEqual(suggestBash(cmd).rules, want, cmd);
});

test('rules use the documented "prefix *" form and never a bare wildcard', () => {
  for (const [cmd] of CASES) for (const r of suggestBash(cmd).rules) {
    assert.match(r, /^Bash\(.+\)$/);
    assert.notEqual(r, 'Bash(*)');
    assert.ok(!/^Bash\(\S+ \*\)$/.test(r) || /^Bash\((npm|tee) /.test(r), `too broad: ${r}`);
  }
});

test('compound commands split on shell operators, not inside quotes', () => {
  assert.deepEqual(splitCompound('a && b || c; d | e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitCompound('echo "a && b"'), ['echo "a && b"']);
});

test('production pushes and deploys carry a warning', () => {
  assert.ok(suggestBash('vercel deploy --prod').notes.some((n) => /production/.test(n)));
  assert.ok(suggestBash('git push origin main').notes.some((n) => /production/.test(n)));
});

test('WebFetch, Edit/Write, Read outside project, MCP', () => {
  assert.deepEqual(suggestOther({ tool: 'WebFetch', url: 'https://docs.example.com/a/b' }).rules, ['WebFetch(domain:docs.example.com)']);
  const w = suggestOther({ tool: 'Write', filePath: 'src/app.ts', project: '/proj' });
  assert.deepEqual(w.rules, ['Edit(/src/app.ts)']);
  assert.ok(w.notes.some((n) => /Edit\(\.\.\.\) rules/.test(n)));
  assert.deepEqual(suggestOther({ tool: 'Read', filePath: '/etc/hosts', project: '/proj' }).rules, ['Read(//etc/hosts)']);
  assert.deepEqual(suggestOther({ tool: 'mcp__github__create_issue' }).rules, ['mcp__github__create_issue']);
});

test('CLI: no rule for a user decline, a deny rule or a hook', () => {
  for (const msg of ["The user doesn't want to proceed", 'matches a deny rule', 'PreToolUse:Bash hook error: blocked']) {
    const r = JSON.parse(spawnSync(process.execPath, [CLI, '--tool', 'Bash', '--command', 'npm run deploy', '--message', msg, '--json'], { encoding: 'utf8' }).stdout);
    assert.equal(r.settings, null, msg);
  }
});

test('CLI --write merges into the project settings without duplicates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploysmoke-pu-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test *)'], deny: ['Read(./.env)'] }, env: { A: '1' } }));
  for (let i = 0; i < 2; i++) spawnSync(process.execPath, [CLI, '--tool', 'Bash', '--command', 'npm run build', '--project', dir, '--write']);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.allow, ['Bash(npm test *)', 'Bash(npm run build *)']);
  assert.deepEqual(s.permissions.deny, ['Read(./.env)']);
  assert.deepEqual(s.env, { A: '1' });
});
