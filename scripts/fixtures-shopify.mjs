#!/usr/bin/env node
// pnpm fixtures:shopify push|preview|check
//   push    -> uploads fixtures/shopify/theme to YOUR development store as a NEW UNPUBLISHED theme (never live).
//   preview -> local storefront preview on http://localhost:9292 (liquidjs + mock data; not Shopify).
//   check   -> Theme Check (offline, @shopify/theme-check-node) on the fixture theme.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const themeDir = join(root, 'fixtures', 'shopify', 'theme');
const [cmd = 'preview', ...rest] = process.argv.slice(2);

if (cmd === 'push') {
  const store = process.env.SHOPIFY_FIXTURE_STORE ?? rest.find((a) => a.endsWith('.myshopify.com'));
  if (!store) {
    console.error('Set SHOPIFY_FIXTURE_STORE=<your-dev-store>.myshopify.com (a free Partner development store).');
    process.exit(1);
  }
  if (rest.some((a) => a === '--live' || a === '--allow-live')) {
    console.error('The fixture is never pushed live.');
    process.exit(1);
  }
  const r = spawnSync('shopify', ['theme', 'push', '--unpublished', '--theme', 'SpeedPilot fixture', '--store', store, '--path', themeDir, '--json'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  let id;
  try {
    id = JSON.parse(r.stdout).theme?.id;
  } catch {}
  const dir = join(root, 'runs', 'fixture-shopify');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'state.json');
  const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  writeFileSync(p, JSON.stringify({ ...prev, store, fixtureThemeId: id ? String(id) : undefined, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`Pushed as unpublished theme ${id ?? '(see output)'} on ${store}. Run: shopify theme check --path fixtures/shopify/theme`);
} else if (cmd === 'preview') {
  const { startPreview } = await import(join(root, 'packages', 'shopify', 'dist', 'index.js'));
  const port = Number(rest[0] ?? 9292);
  const srv = await startPreview({ themeDir, port });
  console.log(`Local fixture preview on ${srv.url} (not Shopify; numbers are indicative). Ctrl+C to stop.`);
} else if (cmd === 'check') {
  const tc = await import('@shopify/theme-check-node');
  const r = await tc.themeCheckRun(themeDir, undefined, () => {});
  for (const o of r.offenses) console.log(`${o.check}\t${o.uri.split('/theme/')[1]}\t${o.message}`);
  console.log(`${r.offenses.length} offences`);
} else {
  console.error('usage: pnpm fixtures:shopify push|preview|check');
  process.exit(1);
}
