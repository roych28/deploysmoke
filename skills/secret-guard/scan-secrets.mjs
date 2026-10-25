#!/usr/bin/env node
// deploysmoke / secret-guard: find secrets before they reach a commit, a push, a log or the chat.
// Single file, no dependencies, no network. Findings are always printed masked.
//
//   node scan-secrets.mjs --staged [--repo <path>]       scan what `git commit` would record (added lines + staged file names)
//   node scan-secrets.mjs --diff <range> [--repo <path>] scan added lines in a range, e.g. origin/main..HEAD before a push
//   node scan-secrets.mjs <file|dir> ...                 scan files (dirs recursively; skips .git, node_modules, binaries)
//   some-command | node scan-secrets.mjs -               scan text on stdin
//   some-command | node scan-secrets.mjs --redact        print stdin with every secret masked (always exits 0)
//   add --json for machine-readable output
//
// Exit codes: 0 clean, 1 secrets found, 2 usage or git error.
// Allow a known-safe line with a trailing comment containing "secret-guard:allow".
// Skip paths with a .secretguardignore file at the repo root (one glob per line, # comments).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret-access-key', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[0-9a-zA-Z]{24,}\b/g },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[0-9a-zA-Z]{24,}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { id: 'anthropic-api-key', re: /\bsk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-api-key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'sendgrid-api-key', re: /\bSG\.[\w-]{22}\.[\w-]{43}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'url-with-password', group: 1, re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|https?):\/\/[^\s:/@'"]+:([^\s@/'"]{3,})@[^\s'"]+/g, check: (m) => !isPlaceholder(m[1]) },
  {
    id: 'secret-assignment',
    group: 2,
    re: /\b([A-Za-z0-9_.-]*(?:secret|token|api[_-]?key|apikey|passw(?:or)?d|pwd|private[_-]?key|access[_-]?key|auth[_-]?key|credential)s?)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.~]{16,})(?![A-Za-z0-9_\-+/=.~(])/gi,
    check: (m) => !isPlaceholder(m[2]) && !isCodeReference(m[2]) && entropy(m[2]) >= 3.5 && !/^[a-z]+(?:[._-][a-z]+)*$/.test(m[2]),
  },
];

const PLACEHOLDER = /^(?:x{4,}|\*{3,}|<[^>]*>|\$\{?[A-Z_]+\}?|%[A-Z_]+%|your[-_]|example|changeme|change[-_]me|placeholder|dummy|redacted|replace[-_]?me|todo|none|null|undefined|password|passw0rd|secret|test|fake|sample)/i;
// process.env.API_KEY, settings.auth.token, os.environ...: a reference to a secret, not the secret.
function isCodeReference(v) { return /^(?:[A-Za-z_$][\w$]{0,63})(?:\.[A-Za-z_$][\w$]{0,63})+$/.test(v) || (/^[A-Za-z_]+$/.test(v) && v.length < 32); }
function isPlaceholder(v) { return PLACEHOLDER.test(v) || /^(.)\1+$/.test(v); }
function entropy(s) {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
}

const SENSITIVE_FILE = [
  { id: 'env-file', re: /(^|\/)\.env(\.[\w.-]+)?$/, unless: /\.(example|sample|template|dist|defaults)$/ },
  { id: 'private-key-file', re: /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|p12|pfx|key|keystore|jks))$/, unless: /\.pub$/ },
  { id: 'credentials-file', re: /(^|\/)(credentials(\.json)?|service[-_]account[^/]*\.json|\.npmrc|\.pypirc|\.netrc)$/ },
];

// Show the match with only its secret part masked (a key name or host is useful and not secret).
function display(rule, m) {
  if (!rule.group) return mask(m[0]);
  const v = m[rule.group];
  const at = m[0].lastIndexOf(v);
  return m[0].slice(0, at) + mask(v) + m[0].slice(at + v.length);
}

export function mask(s) {
  if (s.startsWith('-----BEGIN')) return s;
  return s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 4)}${'*'.repeat(8)} (${s.length} chars)`;
}

export function scanText(text, file = '<stdin>', lineOffset = null) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/secret-guard:\s*allow/.test(line)) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line))) {
        if (rule.check && !rule.check(m)) continue;
        const lineNo = lineOffset ? lineOffset[i] : i + 1;
        findings.push({ rule: rule.id, file, line: lineNo, match: display(rule, m) });
      }
    }
  });
  return findings;
}

export function redact(text) {
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args) => {
      const m = args.slice(0, -2);
      if (rule.check && !rule.check(m)) return m[0];
      return rule.id === 'private-key' ? '[REDACTED PRIVATE KEY]' : display(rule, m);
    });
  }
  return out;
}

export function sensitiveFile(file) {
  for (const s of SENSITIVE_FILE) if (s.re.test(file) && !(s.unless && s.unless.test(file))) return s.id;
  return null;
}

function loadIgnore(repo) {
  try {
    return fs.readFileSync(path.join(repo, '.secretguardignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '(/.*)?$'));
  } catch { return []; }
}

// Parse `git diff -U0` output into added lines per file with their line numbers.
export function scanDiff(diff, ignore = []) {
  const findings = [];
  let file = null, lineNo = 0, added = [], numbers = [];
  const flush = () => { if (file && added.length && !ignore.some((r) => r.test(file))) findings.push(...scanText(added.join('\n'), file, numbers)); added = []; numbers = []; };
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git')) { flush(); file = null; continue; }
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(4).replace(/^b\//, ''); continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { lineNo = Number(h[1]); continue; }
    if (l.startsWith('+') && file) { added.push(l.slice(1)); numbers.push(lineNo++); }
  }
  flush();
  return findings;
}

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }

function walk(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (/(^|\/)(\.git|node_modules)$/.test(p)) return;
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), out);
  } else if (st.size < 5 * 1024 * 1024) out.push(p);
}

function main() {
  const args = process.argv.slice(2);
  const opt = { repo: process.cwd(), json: false, mode: null, range: null, paths: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--staged') opt.mode = 'staged';
    else if (a === '--diff') { opt.mode = 'diff'; opt.range = args[++i]; }
    else if (a === '--repo') opt.repo = path.resolve(args[++i]);
    else if (a === '--redact') opt.mode = 'redact';
    else if (a === '--json') opt.json = true;
    else if (a === '-') opt.mode = 'stdin';
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
    else { opt.mode = opt.mode || 'files'; opt.paths.push(a); }
  }
  if (!opt.mode) opt.mode = process.stdin.isTTY ? null : 'stdin';
  if (!opt.mode) { console.error('usage: scan-secrets.mjs --staged | --diff <range> | <file...> | - | --redact   (see --help)'); process.exit(2); }

  if (opt.mode === 'redact') { process.stdout.write(redact(fs.readFileSync(0, 'utf8'))); process.exit(0); }

  let findings = [];
  try {
    if (opt.mode === 'staged' || opt.mode === 'diff') {
      const ignore = loadIgnore(opt.repo);
      const range = opt.mode === 'staged' ? ['--cached'] : [opt.range];
      const names = git(opt.repo, ['diff', ...range, '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
      for (const f of names) { const id = sensitiveFile(f); if (id && !ignore.some((r) => r.test(f))) findings.push({ rule: id, file: f, line: null, match: '(whole file)' }); }
      findings.push(...scanDiff(git(opt.repo, ['diff', ...range, '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR']), ignore));
    } else if (opt.mode === 'stdin') {
      findings = scanText(fs.readFileSync(0, 'utf8'));
    } else {
      const files = [];
      for (const p of opt.paths) walk(p, files);
      for (const f of files) {
        const id = sensitiveFile(f);
        if (id) findings.push({ rule: id, file: f, line: null, match: '(whole file)' });
        const buf = fs.readFileSync(f);
        if (buf.includes(0)) continue; // binary
        findings.push(...scanText(buf.toString('utf8'), f));
      }
    }
  } catch (e) {
    console.error(`secret-guard: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    process.exit(2);
  }

  if (opt.json) console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  else if (findings.length) {
    console.error(`secret-guard: ${findings.length} possible secret(s). Nothing was committed or printed in full.`);
    for (const f of findings) console.error(`  ${f.rule.padEnd(26)} ${f.file}${f.line ? `:${f.line}` : ''}  ${f.match}`);
    console.error([
      '',
      'Fix: move the value to an environment variable or a gitignored file, unstage it (git restore --staged <file>),',
      'and if it was ever pushed or shared, rotate it: deleting the line does not un-leak it.',
      'False positive? Add "secret-guard:allow" in a comment on that line, or a path glob to .secretguardignore.',
    ].join('\n'));
  } else if (!opt.json) console.error('secret-guard: no secrets found.');
  process.exit(findings.length ? 1 : 0);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) main();
