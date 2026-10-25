#!/usr/bin/env node
// deploysmoke / permission-unblock: work out which gate refused a Claude Code tool call and print the
// narrowest rule for the PROJECT's .claude/settings.json. Rule syntax follows
// https://code.claude.com/docs/en/permissions (Bash wildcards, Read/Edit gitignore paths, WebFetch domains, MCP names).
//
//   node suggest-rule.mjs --tool Bash --command "<the denied command>" [--message "<the denial text>"]
//   node suggest-rule.mjs --tool WebFetch --url <url>
//   node suggest-rule.mjs --tool Edit|Write|Read --path <file> [--project <dir>]
//   node suggest-rule.mjs --tool mcp__<server>__<tool>
//   add --json for machine-readable output; --write --project <dir> merges the allow rules into
//   <dir>/.claude/settings.json (only run that after the user approved the rule).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- which gate refused ----------
export function classifyGate(message = '') {
  const m = message.toLowerCase();
  if (!m.trim()) return 'unknown';
  if (/classifier|auto mode|auto-mode/.test(m)) return 'auto-mode-classifier';
  if (/hook/.test(m)) return 'hook';
  if (/deny rule|denied by (a |your )?(permission )?rule|matches a deny|disallowed/.test(m)) return 'deny-rule';
  if (/(user|you) (rejected|declined|denied|doesn't want|does not want|chose not)|rejected by the user|the user said no/.test(m)) return 'user-declined';
  if (/requires approval|permission|not allowed|has been denied|haven't granted|not granted/.test(m)) return 'missing-allow-rule';
  return 'unknown';
}

// ---------- shell parsing ----------
export function splitCompound(cmd) {
  const parts = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], two = cmd.slice(i, i + 2);
    if (q) { cur += c; if (c === q) q = null; else if (c === '\\' && q === '"') cur += cmd[++i] ?? ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[++i] ?? ''); continue; }
    if (two === '&&' || two === '||' || two === '|&') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i + 1] !== '>' && cmd[i - 1] !== '>')) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function tokenize(s) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob']);
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'wc', 'which', 'diff', 'stat', 'du', 'cd', 'true', 'false']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'deno', 'bun', 'php', 'tsx', 'ts-node']);
const RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pnpx']);
const DANGEROUS = new Set(['rm', 'sudo', 'su', 'chmod', 'chown', 'dd', 'mkfs', 'shred', 'kill', 'killall', 'pkill', 'eval', 'exec', 'xargs', 'env', 'watch', 'ssh', 'scp']);
const MULTI_LEVEL = new Set(['gh', 'aws', 'gcloud', 'az', 'docker', 'kubectl', 'fly', 'flyctl', 'vercel', 'wrangler', 'netlify', 'supabase', 'firebase', 'heroku', 'railway', 'stripe']);
const RUN_SUB = { npm: ['run', 'run-script'], pnpm: ['run'], yarn: ['run'], bun: ['run'] };
const EXEC_SUB = { npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['dlx', 'exec'], docker: ['exec', 'run'], devbox: ['run'], mise: ['exec', 'x'], direnv: ['exec'], uv: ['run'], poetry: ['run'] };

function stripPrefix(tokens) {
  const t = [...tokens];
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
  while (t.length && WRAPPERS.has(t[0])) {
    const w = t.shift();
    if (w === 'timeout') { while (t.length && t[0].startsWith('-')) t.shift(); t.shift(); }
    else while (t.length && t[0].startsWith('-')) t.shift();
  }
  return t;
}

const q = (tokens) => tokens.map((x) => (/[\s"'$`\\]/.test(x) ? JSON.stringify(x) : x)).join(' ');
const isProdDeploy = (s) => /\b(--prod|--production)\b|\bvercel\s+(deploy\s+)?--prod|\bfly(ctl)?\s+deploy\b|\bgit\s+(-C\s+\S+\s+)?push\b.*\b(main|master|production|prod)\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(apply|delete)\b/.test(s);

/** One rule (or a reason none is safe) for a single simple command. */
export function bashRuleFor(sub) {
  const raw = sub.trim();
  const tokens = stripPrefix(tokenize(raw));
  const res = { command: raw, rule: null, kind: null, notes: [] };
  if (!tokens.length) { res.kind = 'none'; res.notes.push('empty command'); return res; }
  const [prog, ...args] = tokens;
  const name = path.basename(prog);
  const exact = () => `Bash(${raw})`;

  if (READ_ONLY.has(name) && !/[>]/.test(raw)) { res.kind = 'read-only'; res.notes.push(`"${name}" is a built-in read-only command: no rule needed`); return res; }
  if (name === 'find' && !/\s-(exec|execdir|ok|delete|fprint|fprintf|fls)\b|-files0-from/.test(raw)) { res.kind = 'read-only'; res.notes.push('read-only find: no rule needed'); return res; }
  if (prog.includes('/') && !prog.startsWith('./') && !prog.startsWith('../')) res.notes.push('rules match the text as written: this rule will not cover the same program called by another path');

  if (DANGEROUS.has(name) || /(^|\s)--force(-with-lease)?\b|\s-f\b.*\bpush\b|\bpush\b.*\s-f\b|\bpush\b.*--force/.test(raw)) {
    res.kind = 'exact'; res.rule = exact();
    res.notes.push(`"${name}" can do irreversible or arbitrary things: approve this one call instead of saving a rule, or save only this exact command`);
    return res;
  }
  if (INTERPRETERS.has(name)) {
    const script = args.find((a) => !a.startsWith('-'));
    const inline = args.some((a) => ['-e', '-c', '-p', '--eval', '--print', '-m'].includes(a)) || raw.includes('<<');
    if (inline || !script) { res.kind = 'exact'; res.rule = exact(); res.notes.push('inline code: a wildcard here would allow any code. Only this exact command is safe to allow'); return res; }
    const upto = args.indexOf(script);
    res.kind = 'prefix'; res.rule = `Bash(${q([prog, ...args.slice(0, upto + 1)])} *)`;
    res.notes.push(`pins the script ${script}; any arguments after it are allowed`);
    return res;
  }
  if (RUNNERS.has(name)) {
    const words = args.filter((a) => !a.startsWith('-'));
    if (!words.length) { res.kind = 'exact'; res.rule = exact(); return res; }
    const take = words.slice(0, Math.min(2, words.length));
    const lastIdx = args.indexOf(take[take.length - 1]);
    res.kind = 'prefix'; res.rule = `Bash(${q([prog, ...args.slice(0, lastIdx + 1)])} *)`;
    res.notes.push(`${name} downloads and runs a package: the rule pins the package (${take[0]}); check it is the one you expect`);
    return res;
  }
  // leading options belong to the rule as written (git -C <dir> push ...)
  let i = 0; const lead = [];
  const VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '-n', '--context', '--profile', '--region', '--project', '--cwd', '--prefix', '-w', '--workspace', '--filter', '--scope', '--team', '--token']);
  while (i < args.length && args[i].startsWith('-')) { lead.push(args[i]); if (VALUED.has(args[i]) && i + 1 < args.length) lead.push(args[++i]); i++; }
  if (lead.includes('--token')) { res.kind = 'none'; res.notes.push('a token on the command line ends up in logs and shell history: put it in the environment instead, then allow the command without it'); return res; }
  if (name === 'git' && lead.includes('-c')) { res.kind = 'exact'; res.rule = exact(); res.notes.push('git -c can make git run any program (core.fsmonitor, core.sshCommand...): only this exact command'); return res; }
  const sub1 = args[i];
  if (sub1 === undefined) { res.kind = 'exact'; res.rule = exact(); return res; }
  if (EXEC_SUB[name]?.includes(sub1)) { res.kind = 'exact'; res.rule = exact(); res.notes.push(`"${name} ${sub1}" runs whatever follows: a wildcard would allow any command, so only this exact one`); return res; }
  let words = [sub1];
  const sub2 = args[i + 1];
  const plain = (w) => w !== undefined && /^[a-z][a-z0-9:_-]*$/i.test(w) && !w.startsWith('-');
  if ((RUN_SUB[name]?.includes(sub1) || MULTI_LEVEL.has(name)) && plain(sub2)) words = [sub1, sub2];
  res.kind = 'prefix';
  res.rule = `Bash(${q([prog, ...lead, ...words])} *)`;
  if (lead.length) res.notes.push(`the rule includes ${q(lead)} because rules match the command as written; "${name} ${words.join(' ')}" without it would not match`);
  return res;
}

export function suggestBash(command) {
  const parts = splitCompound(command).map(bashRuleFor);
  const rules = [...new Set(parts.map((p) => p.rule).filter(Boolean))];
  const notes = [];
  if (parts.length > 1) notes.push('compound command: each part needs its own rule, one rule never covers "a && b"');
  if (isProdDeploy(command)) notes.push('this deploys or pushes to production: consider leaving it un-allowed (or an "ask" rule) so a human approves each one');
  if (/\$\(|`/.test(command)) notes.push('command substitution inside: the inner command is checked separately');
  return { rules, parts, notes };
}

export function suggestOther({ tool, url, filePath, project }) {
  const notes = [];
  if (tool === 'WebFetch') {
    const host = new URL(url).hostname.toLowerCase();
    return { rules: [`WebFetch(domain:${host})`], notes: [`matches ${host} only; subdomains need WebFetch(domain:*.${host.split('.').slice(-2).join('.')})`] };
  }
  if (['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const kind = tool === 'Read' ? 'Read' : 'Edit';
    if (tool !== kind) notes.push(`${tool} is governed by Edit(...) rules; a ${tool}(...) path rule never matches`);
    const abs = path.resolve(project || process.cwd(), filePath);
    const root = path.resolve(project || process.cwd());
    if (abs === root || abs.startsWith(root + path.sep)) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      notes.push('"/path" in project settings is relative to the project root; widen to a folder with /dir/** only if needed');
      if (/(^|\/)(\.git|\.claude)(\/|$)/.test(rel)) notes.push('this is a protected path (.git or .claude): edits there prompt in every mode except bypass, by design. Prefer making the change yourself');
      return { rules: [`${kind}(/${rel})`], notes };
    }
    notes.push('outside the project: "//" means an absolute path. If the agent needs this folder for the whole task, adding it with /add-dir may be the better fix');
    return { rules: [`${kind}(/${abs.split(path.sep).join('/')})`], notes };
  }
  if (/^mcp__[^_].*__.+/.test(tool)) return { rules: [tool], notes: ['one MCP tool; mcp__<server>__* would allow every tool of that server'] };
  return { rules: [], notes: [`no rule template for "${tool}": open /permissions, select Allow, and add it there`] };
}

export const GATE_ADVICE = {
  'missing-allow-rule': 'No allow rule covered this call, and the prompt was refused or could not be shown. A project allow rule fixes it.',
  'user-declined': 'The user said no at the prompt. Do not add a rule and do not retry another way. Ask what they want instead.',
  'deny-rule': 'A deny rule matched. Allow rules can never override a deny rule. Run /permissions to see which file it comes from; only its owner should change it. Do not work around it.',
  'hook': 'A PreToolUse hook blocked the call. Allow rules do not help: a blocking hook runs before them. Read the hook\'s reason, change the command to satisfy it, or ask the user to change the hook in its settings file.',
  'auto-mode-classifier': 'The auto mode classifier judged the call risky. A narrow project allow rule is resolved before the classifier (broad ones like Bash(*) or interpreter wildcards are suspended in auto mode, and autoMode.classifyAllShell suspends all shell rules). If the user meant this exact action, they can say so in their next message and you retry once; /permissions > Recently denied can also retry it. Trusted hosts and repos go in autoMode.environment, which is read only from ~/.claude/settings.json or managed settings, never from the project: that is the user\'s call, not yours.',
  'unknown': 'Could not tell which gate refused from the message. Check /permissions (rules and their source files, and the Recently denied tab in auto mode) and the hooks in .claude/settings.json.',
};

function mergeIntoSettings(project, rules) {
  const file = path.join(project, '.claude', 'settings.json');
  let json = {};
  if (fs.existsSync(file)) json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.permissions = json.permissions || {};
  const allow = new Set(json.permissions.allow || []);
  const added = rules.filter((r) => !allow.has(r));
  json.permissions.allow = [...allow, ...added];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return { file, added };
}

function main() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const tool = get('--tool');
  if (!tool) { console.error('usage: node suggest-rule.mjs --tool <Bash|WebFetch|Edit|Read|mcp__x__y> [--command ...|--url ...|--path ...] [--message "<denial text>"] [--project <dir>] [--json] [--write]'); process.exit(2); }
  const gate = classifyGate(get('--message'));
  const project = get('--project') ? path.resolve(get('--project')) : process.cwd();
  let s;
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (!get('--command')) { console.error('--command is required for Bash'); process.exit(2); }
    s = suggestBash(get('--command'));
    if (tool === 'PowerShell') s.rules = s.rules.map((r) => r.replace(/^Bash\(/, 'PowerShell('));
  } else s = suggestOther({ tool, url: get('--url'), filePath: get('--path'), project });
  const rules = ['user-declined', 'deny-rule', 'hook'].includes(gate) ? [] : s.rules;
  const out = { gate, advice: GATE_ADVICE[gate], file: path.join(project, '.claude', 'settings.json'), settings: rules.length ? { permissions: { allow: rules } } : null, parts: s.parts, notes: s.notes };
  if (a.includes('--write')) {
    if (!rules.length) { console.error('nothing to write for this gate'); process.exit(1); }
    out.written = mergeIntoSettings(project, rules);
  }
  if (a.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`gate     : ${gate}\n           ${out.advice}`);
  for (const p of s.parts || []) console.log(`part     : ${p.command}\n           -> ${p.rule || '(no rule)'}${p.notes.length ? `   ${p.notes.join('; ')}` : ''}`);
  for (const n of s.notes) console.log(`note     : ${n}`);
  if (out.settings) console.log(`\nadd to ${out.file} (merge into the existing "permissions.allow" array):\n${JSON.stringify(out.settings, null, 2)}`);
  if (out.written) console.log(`\nwritten  : ${out.written.file} (+${out.written.added.length})`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
