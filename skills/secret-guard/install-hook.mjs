#!/usr/bin/env node
// deploysmoke / secret-guard: install a git pre-commit hook that blocks commits containing secrets.
//
//   node install-hook.mjs [--repo <path>] [--force]
//
// Copies scan-secrets.mjs next to the hook (so plugin updates or moves never break it) and writes
// a pre-commit hook that runs it on the staged changes. Respects core.hooksPath. Refuses to replace
// an existing pre-commit hook it did not write unless --force (the old one is kept as pre-commit.bak).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = '# deploysmoke secret-guard';
const args = process.argv.slice(2);
const repo = path.resolve(args.includes('--repo') ? args[args.indexOf('--repo') + 1] : process.cwd());
const force = args.includes('--force');

let hooks;
try {
  hooks = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim();
} catch { console.error(`not a git repository: ${repo}`); process.exit(2); }
if (!path.isAbsolute(hooks)) hooks = path.join(repo, hooks);
fs.mkdirSync(hooks, { recursive: true });

const hook = path.join(hooks, 'pre-commit');
if (fs.existsSync(hook) && !fs.readFileSync(hook, 'utf8').includes(MARK)) {
  if (!force) {
    console.error(`${hook} already exists and was not written by deploysmoke. Not touching it.`);
    console.error(`Add this line to it instead:\n  node "${path.join(hooks, 'deploysmoke-scan-secrets.mjs')}" --staged || exit 1`);
    console.error('or run again with --force (the existing hook is kept as pre-commit.bak).');
    fs.copyFileSync(fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url)), path.join(hooks, 'deploysmoke-scan-secrets.mjs'));
    process.exit(1);
  }
  fs.renameSync(hook, `${hook}.bak`);
}

fs.copyFileSync(fileURLToPath(new URL('./scan-secrets.mjs', import.meta.url)), path.join(hooks, 'deploysmoke-scan-secrets.mjs'));
fs.writeFileSync(hook, `#!/bin/sh
${MARK} (installed by install-hook.mjs). Blocks commits that add secrets.
if ! command -v node >/dev/null 2>&1; then
  echo "secret-guard: node is not on PATH, so staged changes were not scanned. Commit blocked." >&2
  exit 1
fi
exec node "$(dirname "$0")/deploysmoke-scan-secrets.mjs" --staged
`, { mode: 0o755 });
fs.chmodSync(hook, 0o755);
console.log(`installed: ${hook}`);
