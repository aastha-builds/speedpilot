#!/usr/bin/env node
// pnpm fixtures:wp up|down|reset [--engine wp-env|compose]
// Local fixture only (exempt from the remote guard). Engine: wp-env by default; compose when wordpress.org is unreachable.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'fixtures', 'wp');
const [cmd = 'up', ...rest] = process.argv.slice(2);
const engineArg = rest.find((a) => a.startsWith('--engine'))?.split('=')[1] ?? (rest.includes('--engine') ? rest[rest.indexOf('--engine') + 1] : undefined);
const WOO_VERSION = process.env.SPF_WOO_VERSION ?? '10.3.0';

function sh(c, args, opts = {}) {
  const r = spawnSync(c, args, { stdio: 'inherit', cwd: fx, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(`${c} ${args.join(' ')} failed (${r.status})`);
    process.exit(r.status ?? 1);
  }
  return r;
}

function canReachWordPressOrg() {
  const r = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', 'https://api.wordpress.org/core/version-check/1.7/'], { encoding: 'utf8' });
  return r.stdout.trim() === '200';
}

const engine = engineArg ?? process.env.SPF_WP_ENGINE ?? (canReachWordPressOrg() ? 'wp-env' : 'compose');

async function waitFor(url, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function ensureWoo() {
  const dest = join(fx, '.cache', 'plugins', 'woocommerce');
  if (existsSync(join(dest, 'woocommerce.php'))) return;
  mkdirSync(join(fx, '.cache'), { recursive: true });
  const zip = join(fx, '.cache', 'woocommerce.zip');
  const urls = [`https://downloads.wordpress.org/plugin/woocommerce.${WOO_VERSION}.zip`, `https://github.com/woocommerce/woocommerce/releases/download/${WOO_VERSION}/woocommerce.zip`];
  for (const u of urls) {
    const r = spawnSync('curl', ['-sSfL', '--max-time', '300', '-o', zip, u]);
    if (r.status === 0) break;
  }
  if (!existsSync(zip)) {
    console.warn('WooCommerce could not be downloaded; the fixture runs without it (cart planted problems will be missing).');
    mkdirSync(dest, { recursive: true });
    return;
  }
  mkdirSync(join(fx, '.cache', 'plugins'), { recursive: true });
  sh('unzip', ['-q', '-o', zip, '-d', join(fx, '.cache', 'plugins')]);
}

function startThirdParty() {
  const pidFile = join(fx, '.cache', 'thirdparty.pid');
  mkdirSync(join(fx, '.cache'), { recursive: true });
  stopThirdParty();
  const fd = openSync(join(fx, '.cache', 'thirdparty.log'), 'a');
  const child = spawn(process.execPath, [join(root, 'fixtures', 'thirdparty', 'server.mjs')], { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
}

function stopThirdParty() {
  const pidFile = join(fx, '.cache', 'thirdparty.pid');
  if (!existsSync(pidFile)) return;
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')));
  } catch {}
  rmSync(pidFile, { force: true });
}

function writeState() {
  const dir = join(root, 'runs', 'fixture-wp');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'state.json');
  const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  writeFileSync(p, JSON.stringify({ ...prev, hosts: { local: ['localhost', '127.0.0.1'] }, currentTarget: { stage: 'local', url: 'http://localhost:8888/' }, engine, updatedAt: new Date().toISOString() }, null, 2));
}

async function up() {
  if (engine === 'wp-env') {
    sh('npx', ['-y', '@wordpress/env@10.32.0', 'start']);
    sh('npx', ['-y', '@wordpress/env@10.32.0', 'run', 'cli', 'sh', '/var/www/html/setup/plant.sh']);
  } else {
    ensureWoo();
    sh('docker', ['compose', 'up', '-d', '--wait', 'db', 'wordpress']);
    sh('docker', ['compose', 'up', '-d', 'cli']);
    await waitFor('http://localhost:8888/wp-login.php');
    sh('docker', ['compose', 'exec', '-T', 'cli', 'sh', '/var/www/setup/plant.sh']);
  }
  startThirdParty();
  writeState();
  console.log(`WordPress fixture up on http://localhost:8888 (engine ${engine}); third-party fixture on http://127.0.0.1:8890`);
}

async function down(volumes = false) {
  stopThirdParty();
  if (engine === 'wp-env') sh('npx', ['-y', '@wordpress/env@10.32.0', volumes ? 'destroy' : 'stop'], { allowFail: true, input: 'y\n' });
  else sh('docker', ['compose', 'down', ...(volumes ? ['-v'] : [])], { allowFail: true });
}

/** Runs WP-CLI against the local fixture: pnpm fixtures:wp cli -- plugin list */
function cli(args) {
  if (engine === 'wp-env') return sh('npx', ['-y', '@wordpress/env@10.32.0', 'run', 'cli', 'wp', ...args]);
  return sh('docker', ['compose', 'exec', '-T', 'cli', 'wp', ...args]);
}

if (cmd === 'up') await up();
else if (cmd === 'down') await down(false);
else if (cmd === 'reset') {
  await down(true);
  await up();
} else if (cmd === 'cli') cli(rest.filter((a) => a !== '--' && !a.startsWith('--engine')));
else {
  console.error('usage: pnpm fixtures:wp up|down|reset|cli [--engine wp-env|compose]');
  process.exit(1);
}
