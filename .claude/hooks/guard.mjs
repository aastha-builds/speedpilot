#!/usr/bin/env node
// SpeedPilot PreToolUse guard. Enforces CLAUDE.md rule 10 (SPEC.md 14.1).
// Reads the hook input JSON on stdin. Exit 0 allows the call; exit 2 blocks it with a reason on stderr.
// No dependencies: this file must run with plain Node before `pnpm install`.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------

export function projectRoot() {
  if (process.env.SPEEDPILOT_ROOT) return resolve(process.env.SPEEDPILOT_ROOT);
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Loads runs/<site>/state.json for every site. */
export function loadStates(root) {
  const runsDir = join(root, 'runs');
  const states = [];
  if (!existsSync(runsDir)) return states;
  for (const site of readdirSync(runsDir)) {
    const p = join(runsDir, site, 'state.json');
    if (!existsSync(p)) continue;
    const s = readJson(p);
    if (s && typeof s === 'object') states.push({ site, path: p, mtime: statSync(p).mtimeMs, ...s });
  }
  return states;
}

function siteNames(root) {
  const dir = join(root, 'sites');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'site.yaml')));
}

/** The site a bare `@staging`/`@production` alias refers to. */
function activeSite(root, states) {
  if (process.env.SPEEDPILOT_SITE) return process.env.SPEEDPILOT_SITE;
  const marker = join(root, 'runs', '.active-site');
  if (existsSync(marker)) return readFileSync(marker, 'utf8').trim();
  const sites = siteNames(root);
  if (sites.length === 1) return sites[0];
  const sorted = [...states].sort((a, b) => b.mtime - a.mtime);
  return sorted[0]?.site;
}

function envKeys(root) {
  const keys = new Set();
  for (const f of ['.env.example', '.env.sample']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Shell parsing
// ---------------------------------------------------------------------------

/**
 * Splits a shell command line into simple commands. Returns { segments, subshells }
 * where each segment is an array of word tokens and subshells are the raw strings
 * found in $(...) and backticks, which are checked recursively.
 */
export function parseShell(input) {
  const segments = [];
  const subshells = [];
  let words = [];
  let cur = '';
  let hasWord = false;
  let i = 0;
  const pushWord = () => {
    if (hasWord) words.push(cur);
    cur = '';
    hasWord = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const readSubshell = (open, close) => {
    // i points just past the opening token
    let depth = 1;
    let start = i;
    let q = null;
    while (i < input.length) {
      const c = input[i];
      if (q) {
        if (c === '\\' && q === '"') i++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (open && input.startsWith(open, i)) depth++;
      else if (input.startsWith(close, i)) {
        depth--;
        if (depth === 0) {
          const body = input.slice(start, i);
          i += close.length;
          return body;
        }
      }
      i++;
    }
    return input.slice(start);
  };
  while (i < input.length) {
    const c = input[i];
    if (c === '\\') {
      if (input[i + 1] === '\n') {
        i += 2;
        continue;
      }
      cur += input[i + 1] ?? '';
      hasWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      cur += end === -1 ? input.slice(i + 1) : input.slice(i + 1, end);
      hasWord = true;
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          cur += input[i + 1];
          i += 2;
          continue;
        }
        if (input.startsWith('$(', i)) {
          i += 2;
          const body = readSubshell('$(', ')');
          subshells.push(body);
          cur += '$(' + body + ')';
          continue;
        }
        if (input[i] === '`') {
          i++;
          const body = readSubshell(null, '`');
          subshells.push(body);
          cur += '`' + body + '`';
          continue;
        }
        cur += input[i];
        i++;
      }
      i++;
      hasWord = true;
      continue;
    }
    if (input.startsWith('$(', i)) {
      i += 2;
      const body = readSubshell('$(', ')');
      subshells.push(body);
      cur += '$(' + body + ')';
      hasWord = true;
      continue;
    }
    if (c === '`') {
      i++;
      const body = readSubshell(null, '`');
      subshells.push(body);
      cur += '`' + body + '`';
      hasWord = true;
      continue;
    }
    if (c === '(' && !hasWord) {
      // subshell group: ( cmd ) — treat contents as separate commands
      i++;
      const body = readSubshell('(', ')');
      subshells.push(body);
      continue;
    }
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      // redirections like 2>&1 and >&2
      if (c === '&' && (cur.endsWith('>') || cur.endsWith('<'))) {
        cur += c;
        hasWord = true;
        i++;
        continue;
      }
      pushSegment();
      i++;
      while (i < input.length && (input[i] === '&' || input[i] === '|')) i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      i++;
      continue;
    }
    if (c === '#' && !hasWord) {
      const nl = input.indexOf('\n', i);
      i = nl === -1 ? input.length : nl;
      continue;
    }
    cur += c;
    hasWord = true;
    i++;
  }
  pushSegment();
  return { segments, subshells };
}

/** Separates redirection targets from argv: returns { argv, redirects }. */
function splitRedirects(words) {
  const argv = [];
  const redirects = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const m = /^(\d*|&)(>>?|<|<<<?|>\|)(.*)$/.exec(w);
    if (m && !w.startsWith('<(')) {
      if (m[3] === '') {
        redirects.push({ op: m[2], target: words[k + 1] ?? '' });
        k++;
      } else redirects.push({ op: m[2], target: m[3] });
      continue;
    }
    argv.push(w);
  }
  return { argv, redirects };
}

const WRAPPERS = new Set(['sudo', 'nohup', 'time', 'nice', 'ionice', 'command', 'builtin', 'exec', 'stdbuf', 'timeout', 'doas']);

/** Strips env assignments and wrapper commands from the front. */
function unwrap(argv) {
  let a = [...argv];
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    if (!a.length) return a;
    const head = basename(a[0]);
    if (head === 'env') {
      a.shift();
      while (a.length && (a[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) a.shift();
      if (!a.length) return ['env'];
      continue;
    }
    if (WRAPPERS.has(head)) {
      a.shift();
      if (head === 'timeout') {
        while (a.length && a[0].startsWith('-')) a.shift();
        a.shift(); // duration
      } else {
        while (a.length && a[0].startsWith('-')) a.shift();
      }
      continue;
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Finds a valid approval file for site and stage. operation narrows it to a plan ID or operation name. */
export function findApproval(root, { site, stage, operation }) {
  const sitesToCheck = site ? [site] : existsSync(join(root, 'runs')) ? readdirSync(join(root, 'runs')) : [];
  for (const s of sitesToCheck) {
    const dir = join(root, 'runs', s, 'approvals');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(`.${stage}.json`)) continue;
      const op = f.slice(0, -`.${stage}.json`.length);
      if (operation && op !== operation) continue;
      const a = readJson(join(dir, f));
      if (!a || a.site !== s || a.stage !== stage) continue;
      if (operation && a.operation !== operation) continue;
      const at = Date.parse(a.approvedAt);
      if (!Number.isFinite(at)) continue;
      const age = Date.now() - at;
      if (age < 0 || age > APPROVAL_MAX_AGE_MS) continue;
      if (!a.approvedBy || typeof a.approvedBy !== 'string') continue;
      return { site: s, file: join(dir, f), approval: a };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

const READONLY_WP = [
  ['core', 'version'],
  ['core', 'check-update'],
  ['core', 'verify-checksums'],
  ['plugin', 'list'],
  ['plugin', 'status'],
  ['plugin', 'get'],
  ['plugin', 'path'],
  ['theme', 'list'],
  ['theme', 'status'],
  ['theme', 'get'],
  ['option', 'get'],
  ['option', 'list'],
  ['cron', 'event', 'list'],
  ['cron', 'schedule', 'list'],
  ['cron', 'test'],
  ['db', 'size'],
  ['db', 'tables'],
  ['doctor', 'check'],
  ['doctor', 'list'],
  ['profile', 'stage'],
  ['profile', 'hook'],
  ['transient', 'list'],
  ['cli', 'version'],
  ['cli', 'info'],
  ['package', 'list'],
  ['site', 'list'],
  ['help'],
];

const NEVER_WP = new Set(['eval', 'eval-file', 'shell']);

const READONLY_SQL = /^\s*(select|show|explain|describe|desc|checksum\s+table)\b/i;
const SQL_WRITE_WORDS = /\b(insert|update|delete|replace|drop|alter|create|truncate|rename|grant|revoke|lock|unlock|set|call|load|handler|do|into\s+outfile|into\s+dumpfile)\b/i;

export function isReadOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) return false;
  const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
  if (!statements.length) return false;
  return statements.every((s) => READONLY_SQL.test(s) && !SQL_WRITE_WORDS.test(s.replace(/'[^']*'|"[^"]*"/g, "''")));
}

const READONLY_SHELL = new Set(['df', 'du', 'ls', 'uptime', 'free', 'nproc', 'whoami', 'hostname', 'uname', 'pwd', 'id', 'date', 'stat', 'wc']);

function isLogPath(p) {
  return /\.log(\.\d+)?$/.test(p) || /(^|\/)(logs?|var\/log)\//.test(p);
}

/** Read-only remote shell command? argv after unwrap. */
function isReadOnlyRemoteShell(argv) {
  const head = basename(argv[0] ?? '');
  if (READONLY_SHELL.has(head)) return true;
  if (head === 'tail' || head === 'head') {
    const files = argv.slice(1).filter((a) => !a.startsWith('-') && !/^\d+$/.test(a));
    return files.length > 0 && files.every(isLogPath);
  }
  if (head === 'php' || /^php\d/.test(head)) {
    return argv.slice(1).every((a) => ['-v', '--version', '-m', '--modules', '--ini'].includes(a)) && argv.length > 1;
  }
  return false;
}

/** Parses WP-CLI argv (without the leading `wp`). */
function parseWp(args) {
  const globals = {};
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.startsWith('@')) {
      globals.alias = a.slice(1);
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      globals[name] = eq === -1 ? true : a.slice(eq + 1);
      continue;
    }
    positional.push(a);
  }
  return { globals, positional };
}

function wpIsReadOnly({ globals, positional }) {
  if (globals.exec || globals.require) return { ro: false, never: true, why: 'WP-CLI --exec and --require run arbitrary PHP' };
  if (globals.help) return { ro: true };
  const [sub] = positional;
  if (!sub) return { ro: true };
  if (NEVER_WP.has(sub)) return { ro: false, never: true, why: `wp ${sub} can run any code and is never allowlisted` };
  if (sub === 'db' && positional[1] === 'query') {
    const sql = positional.slice(2).join(' ');
    if (isReadOnlySql(sql)) return { ro: true };
    return { ro: false, why: 'wp db query with SQL that is not read-only' };
  }
  if (sub === 'db' && positional[1] === 'export') {
    return { ro: false, why: 'wp db export runs only through `speedpilot backup`, which checks disk space first' };
  }
  if (sub === 'search-replace') {
    if (globals['dry-run'] && !globals.export) return { ro: true };
    return { ro: false, why: 'wp search-replace without --dry-run' };
  }
  for (const pattern of READONLY_WP) {
    if (pattern.every((p, idx) => positional[idx] === p)) return { ro: true };
  }
  return { ro: false, why: `wp ${positional.slice(0, 3).join(' ')} is not on the read-only allowlist` };
}

function hostOf(target) {
  // user@host, host, ssh://user@host:port
  let t = target.replace(/^ssh:\/\//, '');
  t = t.replace(/^[^@]*@/, '');
  t = t.replace(/[:/].*$/, '');
  return t.toLowerCase();
}

/** Builds host and alias maps from state files. */
function stageMaps(states) {
  const hosts = new Map();
  for (const s of states) {
    for (const stage of ['staging', 'production', 'local']) {
      for (const h of s.hosts?.[stage] ?? []) hosts.set(String(h).toLowerCase(), { site: s.site, stage });
    }
  }
  return { hosts };
}

function stageFromAlias(alias, root, states) {
  if (!alias) return undefined;
  if (alias === 'staging' || alias === 'production') return { site: activeSite(root, states), stage: alias };
  const m = /^(.+?)[.-](staging|production)$/.exec(alias);
  if (m) return { site: m[1], stage: m[2] };
  return { site: activeSite(root, states), stage: 'production', unknown: true };
}

function stageFromHost(host, ctx) {
  const hit = ctx.maps.hosts.get(host);
  if (hit) return hit;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return { site: undefined, stage: 'local' };
  return { site: activeSite(ctx.root, ctx.states), stage: 'production', unknown: true };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

class Blocked extends Error {}

function block(reason) {
  throw new Blocked(reason);
}

function needApproval(ctx, { site, stage, operation, what }) {
  if (stage === 'local') return;
  const a = findApproval(ctx.root, { site, stage, operation });
  if (a) return;
  block(
    `${what} touches ${stage}${site ? ` (site ${site})` : ''} and needs an approval file runs/${site ?? '<site>'}/approvals/${operation ?? '<plan-id or operation>'}.${stage}.json less than 24 hours old. ` +
      `Ask the human to run \`speedpilot approve\` in their own terminal (CLAUDE.md rule 10).`,
  );
}

function isSpeedpilotInvocation(argv) {
  const head = basename(argv[0] ?? '');
  if (head === 'speedpilot') return argv.slice(1);
  if ((head === 'pnpm' || head === 'npm' || head === 'yarn') && argv.includes('speedpilot')) {
    const idx = argv.indexOf('speedpilot');
    const rest = argv.slice(idx + 1);
    return rest[0] === '--' ? rest.slice(1) : rest;
  }
  if ((head === 'npx' || head === 'pnpx') && argv.some((a) => a === 'speedpilot' || a.startsWith('speedpilot@') || a === '@speedpilot/cli')) {
    const idx = argv.findIndex((a) => a === 'speedpilot' || a.startsWith('speedpilot@') || a === '@speedpilot/cli');
    return argv.slice(idx + 1);
  }
  if ((head === 'node' || head === 'tsx' || head === 'bun') && argv.some((a) => /packages\/cli\/(dist|src)\/(index|cli)\.[cm]?[jt]s$/.test(a))) {
    const idx = argv.findIndex((a) => /packages\/cli\/(dist|src)\/(index|cli)\.[cm]?[jt]s$/.test(a));
    return argv.slice(idx + 1);
  }
  return undefined;
}

function flagValue(argv, names) {
  for (let k = 0; k < argv.length; k++) {
    for (const n of names) {
      if (argv[k] === n) return argv[k + 1];
      if (argv[k].startsWith(n + '=')) return argv[k].slice(n.length + 1);
    }
  }
  return undefined;
}

function hasFlag(argv, names) {
  return argv.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));
}

const SP_READONLY = new Set(['init', 'access', 'audit', 'report', 'plan', 'verify', 'baseline', 'monitor', 'xray', 'help', '--help', '-h', '--version', 'list', 'findings', 'status']);

function checkSpeedpilot(spArgs, ctx) {
  const [cmd, sub] = spArgs;
  if (cmd === 'approve') block('`speedpilot approve` is typed by the human in their own terminal. Claude never approves its own work (SPEC.md 14.1).');
  if (!cmd || SP_READONLY.has(cmd)) {
    if (cmd === 'xray' && sub === 'simulate') return; // local proxy only
    return;
  }
  if (cmd === 'backup') return; // backup checks disk space and is allowlisted; restore tests need staging-prep approval inside the executor
  const site = flagValue(spArgs, ['--site']) ?? (cmd === 'rollback' || cmd === 'staging' ? spArgs[cmd === 'staging' ? 2 : 1] : undefined);
  if (cmd === 'apply') {
    const stage = flagValue(spArgs, ['--stage']) ?? 'staging';
    return needApproval(ctx, { site: undefined, stage, operation: sub, what: `speedpilot apply ${sub ?? ''}` });
  }
  if (cmd === 'deploy') return needApproval(ctx, { site: undefined, stage: 'production', operation: sub, what: `speedpilot deploy ${sub ?? ''}` });
  if (cmd === 'staging') return needApproval(ctx, { site, stage: 'staging', operation: 'staging-prep', what: 'speedpilot staging prepare' });
  if (cmd === 'rollback') {
    const stage = flagValue(spArgs, ['--stage']) ?? 'production';
    return needApproval(ctx, { site, stage, what: 'speedpilot rollback' });
  }
  // unknown speedpilot command: be strict
  return needApproval(ctx, { site, stage: flagValue(spArgs, ['--stage']) ?? 'production', what: `speedpilot ${cmd}` });
}

function checkShopify(argv, ctx) {
  // argv: shopify theme <sub> ...
  if (argv[1] !== 'theme') {
    if (argv[1] === 'app' || argv[1] === 'auth' || argv[1] === 'version' || argv[1] === 'help' || !argv[1] || argv[1] === '--help' || argv[1] === 'upgrade') return;
    return block(`shopify ${argv[1]} is not used by SpeedPilot`);
  }
  const sub = argv[2];
  const rest = argv.slice(3);
  if (!sub || ['list', 'pull', 'check', 'profile', 'info', 'help', '--help', 'language-server', 'package'].includes(sub)) {
    if (sub === 'pull' && hasFlag(rest, ['--live', '-l'])) return; // pulling the live theme is read-only
    return;
  }
  const store = flagValue(rest, ['--store', '-s']);
  const state = ctx.states.find((s) => (store ? s.store === store : true) && s.workThemeId) ?? ctx.states.find((s) => s.workThemeId);
  const site = state?.site;
  if (sub === 'push') {
    if (hasFlag(rest, ['--live', '-l', '--allow-live', '-a'])) block('shopify theme push --live / --allow-live is always blocked (CLAUDE.md rule 10).');
    const theme = flagValue(rest, ['--theme', '-t']);
    if (!theme) block('shopify theme push without --theme <work-theme-id> is blocked: pushes go to the recorded work theme only.');
    if (!state?.workThemeId) block('No work theme is recorded in runs/<site>/state.json, so this push cannot be placed. Run `speedpilot staging prepare` first.');
    if (String(theme) !== String(state.workThemeId)) block(`shopify theme push to theme ${theme} is blocked: the recorded work theme is ${state.workThemeId}.`);
    return needApproval(ctx, { site, stage: 'staging', what: 'shopify theme push to the work theme' });
  }
  if (sub === 'publish') return needApproval(ctx, { site, stage: 'production', what: 'shopify theme publish' });
  if (sub === 'duplicate') return needApproval(ctx, { site, stage: 'staging', what: 'shopify theme duplicate' });
  if (sub === 'delete' || sub === 'rename' || sub === 'share' || sub === 'dev' || sub === 'console' || sub === 'open' || sub === 'init') {
    if (sub === 'open' || sub === 'init') return;
    const theme = flagValue(rest, ['--theme', '-t']);
    const stage = theme && state?.workThemeId && String(theme) === String(state.workThemeId) ? 'staging' : 'production';
    if (sub === 'delete' && theme && state?.liveThemeId && String(theme) === String(state.liveThemeId)) block('Deleting the live theme is always blocked.');
    return needApproval(ctx, { site, stage, what: `shopify theme ${sub}` });
  }
  return needApproval(ctx, { site, stage: 'production', what: `shopify theme ${sub}` });
}

function checkWp(argv, ctx, forced) {
  const parsed = parseWp(argv.slice(1));
  let placement = forced;
  if (!placement) {
    if (parsed.globals.alias) placement = stageFromAlias(parsed.globals.alias, ctx.root, ctx.states);
    else if (typeof parsed.globals.ssh === 'string') {
      const target = parsed.globals.ssh;
      if (/^docker(-compose)?:/.test(target)) placement = { stage: 'local' };
      else placement = stageFromHost(hostOf(target), ctx);
    } else placement = { site: activeSite(ctx.root, ctx.states), stage: 'production', unknown: true };
  }
  if (placement.stage === 'local') return;
  const verdict = wpIsReadOnly(parsed);
  if (verdict.ro) return;
  if (verdict.never) block(`${verdict.why} (CLAUDE.md rule 10).`);
  needApproval(ctx, { site: placement.site, stage: placement.stage, what: `wp ${parsed.positional.join(' ')}${placement.unknown ? ' (stage unknown, counted as production)' : ''}` });
}

function checkSsh(argv, ctx) {
  // ssh [opts] host [command...]
  const optsWithArg = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
  let k = 1;
  let user;
  while (k < argv.length && argv[k].startsWith('-')) {
    if (optsWithArg.has(argv[k])) {
      if (argv[k] === '-l') user = argv[k + 1];
      k += 2;
    } else k++;
  }
  const target = argv[k];
  if (!target) return;
  const placement = stageFromHost(hostOf(target), ctx);
  const remote = argv.slice(k + 1).join(' ');
  if (placement.stage === 'local') return;
  if (!remote.trim()) return needApproval(ctx, { site: placement.site, stage: placement.stage, what: 'interactive ssh session' });
  checkRemoteCommandLine(remote, ctx, placement);
  void user;
}

function checkRemoteCommandLine(line, ctx, placement) {
  const { segments, subshells } = parseShell(line);
  for (const sub of subshells) checkRemoteCommandLine(sub, ctx, placement);
  for (const words of segments) {
    const { argv, redirects } = splitRedirects(words);
    const a = unwrap(argv);
    if (!a.length) continue;
    checkAlwaysBlocked(a, redirects, ctx);
    if (redirects.some((r) => r.op.startsWith('>') && r.target !== '/dev/null' && !r.target.startsWith('&'))) {
      needApproval(ctx, { site: placement.site, stage: placement.stage, what: `remote file write (${redirects.map((r) => r.op + r.target).join(' ')})` });
      continue;
    }
    const head = basename(a[0]);
    if (head === 'wp') {
      checkWp(a, ctx, placement);
      continue;
    }
    if (head === 'mysql' || head === 'mariadb') {
      const sql = flagValue(a, ['-e', '--execute']);
      if (isReadOnlySql(sql)) continue;
      needApproval(ctx, { site: placement.site, stage: placement.stage, what: 'remote SQL that is not read-only' });
      continue;
    }
    if ((head === 'bash' || head === 'sh' || head === 'zsh') && a[1] === '-c') {
      checkRemoteCommandLine(a.slice(2).join(' '), ctx, placement);
      continue;
    }
    if (isReadOnlyRemoteShell(a)) continue;
    needApproval(ctx, { site: placement.site, stage: placement.stage, what: `remote command \`${a.slice(0, 3).join(' ')}\`` });
  }
}

function resolvesUnderRuns(target, ctx) {
  if (!target || /[*?]/.test(target) && !target.startsWith('runs/')) return false;
  const abs = isAbsolute(target) ? target : resolve(ctx.cwd, target);
  const rel = relative(join(ctx.root, 'runs'), abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function mentionsEnvFile(arg) {
  const b = basename(arg.replace(/^.*=/, ''));
  if (!/^\.env(\..+)?$/.test(b)) return false;
  return !/^\.env\.(example|sample|template)$/.test(b);
}

const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'nl', 'xxd', 'od', 'hexdump', 'strings', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'gawk', 'sed', 'cut', 'sort', 'uniq', 'tac', 'base64', 'cp', 'mv', 'scp', 'rsync', 'curl', 'tee', 'diff', 'vim', 'vi', 'nano', 'code', 'jq', 'source', '.', 'type', 'paste', 'column', 'dd', 'iconv', 'openssl', 'gpg', 'zip', 'tar', 'gzip']);

function checkAlwaysBlocked(a, redirects, ctx) {
  const head = basename(a[0]);
  // speedpilot approve, through any launcher
  const sp = isSpeedpilotInvocation(a);
  if (sp && sp[0] === 'approve') block('`speedpilot approve` is typed by the human in their own terminal. Claude never approves its own work (SPEC.md 14.1).');
  // printing .env or its keys
  const envArgs = a.slice(1).filter(mentionsEnvFile);
  const envRedirect = redirects.some((r) => r.op === '<' && mentionsEnvFile(r.target));
  if ((envArgs.length && (READERS.has(head) || head === 'python' || head === 'python3' || head === 'node' || head === 'perl' || head === 'ruby' || head === 'php')) || envRedirect) {
    block('Reading or printing .env is always blocked (CLAUDE.md rules 10 and 11).');
  }
  if (head === 'printenv' || (head === 'env' && a.length === 1) || (head === 'set' && a.length === 1) || (head === 'export' && (a.length === 1 || a[1] === '-p')) || (head === 'declare' && a.includes('-x'))) {
    block('Printing environment variables is blocked because they may hold .env secrets (CLAUDE.md rule 11).');
  }
  if (head === 'echo' || head === 'printf') {
    const keys = ctx.envKeys;
    for (const arg of a.slice(1)) {
      for (const m of arg.matchAll(/\$\{?([A-Z][A-Z0-9_]*)\}?/g)) {
        if (keys.has(m[1])) block(`Printing ${m[1]} is blocked: it is a .env key (CLAUDE.md rule 11).`);
      }
    }
  }
  // shopify theme push --live / --allow-live
  if (head === 'shopify' && a[1] === 'theme' && a[2] === 'push' && hasFlag(a.slice(3), ['--live', '-l', '--allow-live', '-a'])) {
    block('shopify theme push --live / --allow-live is always blocked (CLAUDE.md rule 10).');
  }
  // git push --force
  if (head === 'git') {
    const pushIdx = a.indexOf('push');
    if (pushIdx !== -1) {
      const rest = a.slice(pushIdx + 1);
      if (rest.some((x) => x === '--force' || x === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(x) || x.startsWith('--force-with-lease') || x === '--force-if-includes' || (/^\+/.test(x) && !x.startsWith('+-')))) {
        block('git push --force is always blocked (CLAUDE.md rule 10).');
      }
    }
  }
  // rm -rf outside runs/
  if (head === 'rm') {
    const flags = a.slice(1).filter((x) => x.startsWith('-') && x !== '--');
    const recursive = flags.some((f) => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)));
    const force = flags.some((f) => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')));
    if (recursive && force) {
      const targets = a.slice(1).filter((x) => !x.startsWith('-'));
      if (!targets.length || !targets.every((t) => resolvesUnderRuns(t, ctx))) block('rm -rf outside runs/ is always blocked (CLAUDE.md rule 10).');
    }
  }
}

function checkLocalSegment(words, ctx) {
  const { argv, redirects } = splitRedirects(words);
  const a = unwrap(argv);
  if (!a.length) return;
  checkAlwaysBlocked(a, redirects, ctx);
  const head = basename(a[0]);

  if ((head === 'bash' || head === 'sh' || head === 'zsh' || head === 'dash') && a[1] === '-c' && a[2]) return checkCommandLine(a[2], ctx);
  if (head === 'eval') return checkCommandLine(a.slice(1).join(' '), ctx);
  if (head === 'xargs') {
    const idx = a.findIndex((x, k) => k > 0 && !x.startsWith('-'));
    if (idx !== -1) return checkLocalSegment(a.slice(idx), ctx);
    return;
  }

  // local fixtures are exempt
  if (head === 'wp-env' || ((head === 'npx' || head === 'pnpm' || head === 'pnpx') && a.some((x) => x === 'wp-env' || x.startsWith('@wordpress/env')))) return;
  if ((head === 'pnpm' || head === 'npm') && a.some((x) => x.startsWith('fixtures:'))) {
    if (a.some((x) => x === 'fixtures:shopify')) {
      // pushes the fixture theme to the development store as an unpublished theme — never live
      if (a.some((x) => x === '--live' || x === '--allow-live')) block('Fixture pushes never go live.');
    }
    return;
  }

  const sp = isSpeedpilotInvocation(a);
  if (sp) return checkSpeedpilot(sp, ctx);

  if (head === 'wp') return checkWp(a, ctx);
  if (head === 'shopify') return checkShopify(a, ctx);
  if (head === 'ssh') return checkSsh(a, ctx);
  if (head === 'scp' || head === 'rsync' || head === 'sftp') {
    const remoteArgs = a.slice(1).filter((x) => /^[^-/][^\s]*:/.test(x) && !/^[a-zA-Z]:\\/.test(x));
    if (!remoteArgs.length && head !== 'sftp') return;
    const target = head === 'sftp' ? a[a.length - 1] : remoteArgs[0];
    const placement = stageFromHost(hostOf(target), ctx);
    if (placement.stage === 'local') return;
    return needApproval(ctx, { site: placement.site, stage: placement.stage, what: `${head} to or from a remote server` });
  }
  if (head === 'mysql' || head === 'mariadb' || head === 'psql') {
    const host = flagValue(a, ['-h', '--host']) ?? 'localhost';
    const placement = stageFromHost(host.toLowerCase(), ctx);
    if (placement.stage === 'local') return;
    const sql = flagValue(a, ['-e', '--execute', '-c', '--command']);
    if (isReadOnlySql(sql)) return;
    return needApproval(ctx, { site: placement.site, stage: placement.stage, what: 'SQL that is not read-only on a remote database' });
  }
  if (head === 'curl' || head === 'wget' || head === 'http' || head === 'https' || head === 'xh') {
    const url = a.slice(1).find((x) => /^https?:\/\//.test(x));
    if (!url) return;
    const host = new URL(url).hostname.toLowerCase();
    const placement = stageFromHost(host, ctx);
    if (placement.stage === 'local') return;
    const method = (flagValue(a, ['-X', '--request', '--method']) ?? '').toUpperCase();
    const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || hasFlag(a, ['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json', '--post-data', '--post-file', '--method']);
    if (!writes) return;
    return needApproval(ctx, { site: placement.site, stage: placement.stage, what: `${head} ${method || 'write'} request to ${host}` });
  }
}

function checkCommandLine(line, ctx) {
  const { segments, subshells } = parseShell(line);
  for (const sub of subshells) checkCommandLine(sub, ctx);
  for (const words of segments) checkLocalSegment(words, ctx);
}

const CDP_INPUT_TOOLS = new Set(['click', 'click_at', 'fill', 'fill_form', 'type_text', 'press_key', 'drag', 'upload_file', 'handle_dialog', 'hover']);

function checkChromeDevtools(toolName, ctx) {
  const short = toolName.replace(/^mcp__chrome-devtools__/, '');
  if (!CDP_INPUT_TOOLS.has(short)) return;
  const sorted = [...ctx.states].sort((a, b) => b.mtime - a.mtime);
  const current = sorted[0]?.currentTarget;
  const stage = current?.stage;
  if (stage === 'local' || stage === 'staging') return;
  block(`Chrome DevTools MCP input tool ${short} is blocked: runs/<site>/state.json does not say the current target is local or staging (CLAUDE.md rule 12).`);
}

/** Main decision function. Returns { allow: true } or { allow: false, reason }. */
export function decide(input, root = projectRoot()) {
  const states = loadStates(root);
  const ctx = {
    root,
    cwd: input.cwd ? resolve(input.cwd) : root,
    states,
    maps: stageMaps(states),
    envKeys: envKeys(root),
  };
  try {
    const tool = input.tool_name ?? '';
    if (tool === 'Bash') checkCommandLine(String(input.tool_input?.command ?? ''), ctx);
    else if (tool.startsWith('mcp__chrome-devtools__')) checkChromeDevtools(tool, ctx);
    else if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'Grep') {
      const p = String(input.tool_input?.file_path ?? input.tool_input?.path ?? '');
      if (tool === 'Read' && mentionsEnvFile(p)) block('Reading .env is blocked (CLAUDE.md rule 11).');
    }
    return { allow: true };
  } catch (e) {
    if (e instanceof Blocked) return { allow: false, reason: e.message };
    // a parsing bug must never open the gate
    return { allow: false, reason: `SpeedPilot guard could not check this command safely: ${e?.message ?? e}` };
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    process.stderr.write('SpeedPilot guard: hook input is not valid JSON; blocking.\n');
    process.exit(2);
  }
  const result = decide(input);
  if (!result.allow) {
    process.stderr.write(`SpeedPilot guard blocked this call: ${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
