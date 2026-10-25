// secret-guard: fake keys are assembled at runtime so this repository never contains a string that looks like a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText, redact, sensitiveFile } from '../skills/secret-guard/scan-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'skills/secret-guard/scan-secrets.mjs');
const INSTALL = path.join(ROOT, 'skills/secret-guard/install-hook.mjs');

// Obviously fake values that only match the shape of each provider's key.
const FAKE = {
  'stripe-live-key': 'sk_live_' + 'x'.repeat(24),
  'aws-access-key-id': 'AKIA' + 'X'.repeat(16),
  'github-token': 'ghp_' + 'x'.repeat(36),
  'github-fine-grained-token': 'github_pat_' + 'x'.repeat(60),
  'anthropic-api-key': 'sk-ant-api03-' + 'x'.repeat(40),
  'openai-api-key': 'sk-proj-' + 'x'.repeat(40),
  'slack-token': 'xoxb-' + '0'.repeat(12) + '-fake',
  'google-api-key': 'AIza' + 'x'.repeat(35),
  'npm-token': 'npm_' + 'x'.repeat(36),
  'private-key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'url-with-password': 'postgres://app:' + 'Zq9Lm2Vt7Word' + '@db.example.com:5432/app',
};

test('each provider pattern is caught, and the output is masked', () => {
  for (const [rule, value] of Object.entries(FAKE)) {
    const f = scanText(`const v = "${value}";`);
    assert.ok(f.some((x) => x.rule === rule), `${rule} not caught: ${JSON.stringify(f)}`);
    if (rule !== 'private-key') assert.ok(!JSON.stringify(f).includes(value), `${rule} printed in full`);
  }
});

test('high-entropy assignment is caught; placeholders and env lookups are not', () => {
  const real = 'Q3v' + '9kLm2' + 'Zp8Rt' + 'X4wN7b';
  assert.ok(scanText(`API_TOKEN=${real}`).some((x) => x.rule === 'secret-assignment'));
  for (const ok of ['API_TOKEN=your-token-here', 'API_TOKEN=${API_TOKEN}', 'password = process.env.DB_PASSWORD', 'SECRET=xxxxxxxxxxxxxxxxxxxx', 'token: <paste-token-here>', 'postgres://user:password@localhost/db']) {
    assert.deepEqual(scanText(ok), [], `false positive on: ${ok}`);
  }
});

test('inline allow marker suppresses a known-safe line', () => {
  assert.deepEqual(scanText(`const k = "${FAKE['stripe-live-key']}"; // secret-guard:allow test fixture`), []);
});

test('--redact masks secrets in command output', () => {
  const out = redact(`token=${FAKE['github-token']}\nok line\n`);
  assert.ok(!out.includes(FAKE['github-token']));
  assert.match(out, /ghp_\*{8} \(40 chars\)/);
  assert.match(out, /ok line/);
});

test('sensitive file names', () => {
  assert.equal(sensitiveFile('.env'), 'env-file');
  assert.equal(sensitiveFile('app/.env.production'), 'env-file');
  assert.equal(sensitiveFile('.env.example'), null);
  assert.equal(sensitiveFile('deploy/id_ed25519'), 'private-key-file');
  assert.equal(sensitiveFile('id_ed25519.pub'), null);
});

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploysmoke-sg-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n'); g('add', 'README.md'); g('commit', '-q', '-m', 'init');
  return { dir, g };
}

test('--staged catches a planted fake key in a temp git repo (masked), and passes once it is removed', () => {
  const { dir, g } = tempRepo();
  fs.writeFileSync(path.join(dir, 'config.js'), `module.exports = {\n  stripe: "${FAKE['stripe-live-key']}",\n};\n`);
  g('add', 'config.js');
  const bad = spawnSync(process.execPath, [SCAN, '--staged', '--repo', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /stripe-live-key\s+config\.js:2/);
  assert.ok(!bad.stderr.includes(FAKE['stripe-live-key']), 'the key must not be printed');
  fs.writeFileSync(path.join(dir, 'config.js'), 'module.exports = { stripe: process.env.STRIPE_SECRET_KEY };\n');
  g('add', 'config.js');
  assert.equal(spawnSync(process.execPath, [SCAN, '--staged', '--repo', dir]).status, 0);
});

test('--staged blocks a staged .env file', () => {
  const { dir, g } = tempRepo();
  fs.writeFileSync(path.join(dir, '.env'), 'DEBUG=1\n');
  g('add', '-f', '.env');
  const r = spawnSync(process.execPath, [SCAN, '--staged', '--repo', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env-file\s+\.env/);
});

test('installed pre-commit hook blocks the commit, then allows a clean one', () => {
  const { dir, g } = tempRepo();
  assert.equal(spawnSync(process.execPath, [INSTALL, '--repo', dir]).status, 0);
  fs.writeFileSync(path.join(dir, 'aws.txt'), `key ${FAKE['aws-access-key-id']}\n`);
  g('add', 'aws.txt');
  const blocked = spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'add key'], { encoding: 'utf8' });
  assert.notEqual(blocked.status, 0, 'commit with a key must fail');
  assert.match(blocked.stderr, /aws-access-key-id/);
  assert.equal(g('rev-list', '--count', 'HEAD').trim(), '1', 'no commit was created');
  fs.writeFileSync(path.join(dir, 'aws.txt'), 'key from AWS_ACCESS_KEY_ID env var\n');
  g('add', 'aws.txt');
  assert.equal(spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'clean']).status, 0);
  assert.equal(g('rev-list', '--count', 'HEAD').trim(), '2');
});

test('installer refuses to overwrite a foreign pre-commit hook', () => {
  const { dir } = tempRepo();
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [INSTALL, '--repo', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('this repository itself contains no secrets', () => {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f));
  const r = spawnSync(process.execPath, [SCAN, '--json', ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});
