import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeState, readState, type SiteConfig, type Store } from '@speedpilot/core';
import { ShopifyCli, type ThemeInfo } from './cli.js';
import { appEmbeds } from './backend.js';

export const THEME_LIMIT = 20;

export interface ShopifyManifest {
  site: string;
  store: string;
  createdAt: string;
  liveThemeId: string;
  liveThemeName: string;
  backupThemeId: string;
  workThemeId: string;
  gitTag: string;
  files: Record<string, string>;
  settingsData: unknown;
  templates: Record<string, unknown>;
  locales: string[];
  appEmbeds: ReturnType<typeof appEmbeds>;
  themeCount: number;
}

export function checksumTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === '.git' || f === '.shopify') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function git(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'SpeedPilot', GIT_AUTHOR_EMAIL: 'speedpilot@localhost', GIT_COMMITTER_NAME: 'SpeedPilot', GIT_COMMITTER_EMAIL: 'speedpilot@localhost' } });
}

/**
 * Shopify backup and work theme (SPEC.md 5.3): theme count check (never deletes a theme), pull of the live theme into
 * git tagged backup-<date>, duplicates as "SpeedPilot backup <date>" (never edited) and "SpeedPilot work <date>".
 */
export async function backupShopify(root: string, cfg: SiteConfig, store: Store, opts: { cli?: ShopifyCli; backupsDir: string; now?: Date }): Promise<{ id: string; dir: string; manifest: ShopifyManifest }> {
  const cli = opts.cli ?? new ShopifyCli(cfg);
  const themes = await cli.list();
  const live = themes.find((t) => t.role === 'live');
  if (!live) throw new Error('No live theme found.');
  // Two duplicates are created: the library needs room for both.
  if (themes.length + 2 > THEME_LIMIT) throw new Error(`The theme library has ${themes.length} of ${THEME_LIMIT} themes; two duplicates need room. Ask the client which themes to remove. SpeedPilot never deletes a theme itself.`);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const id = `bk-${cfg.name}-shopify-${(opts.now ?? new Date()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const dir = join(opts.backupsDir, cfg.name, id);
  const themeDir = join(dir, 'theme');
  mkdirSync(themeDir, { recursive: true });
  await cli.pull(live.id, themeDir);
  git(themeDir, ['init', '-q']);
  git(themeDir, ['add', '-A']);
  git(themeDir, ['commit', '-q', '-m', `backup of live theme ${live.id} (${live.name})`]);
  const tag = `backup-${date}`;
  git(themeDir, ['tag', '-f', tag]);
  const backupTheme = await cli.duplicate(live.id, `SpeedPilot backup ${date}`);
  const workTheme = await cli.duplicate(live.id, `SpeedPilot work ${date}`);
  const templates: Record<string, unknown> = {};
  const tdir = join(themeDir, 'templates');
  if (existsSync(tdir)) for (const f of readdirSync(tdir).filter((x) => x.endsWith('.json'))) templates[f] = JSON.parse(readFileSync(join(tdir, f), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
  const manifest: ShopifyManifest = {
    site: cfg.name,
    store: cfg.access.shopify!.store,
    createdAt: new Date().toISOString(),
    liveThemeId: String(live.id),
    liveThemeName: live.name,
    backupThemeId: String(backupTheme.id),
    workThemeId: String(workTheme.id),
    gitTag: tag,
    files: checksumTree(themeDir),
    settingsData: existsSync(join(themeDir, 'config/settings_data.json')) ? JSON.parse(readFileSync(join(themeDir, 'config/settings_data.json'), 'utf8').replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) : null,
    templates,
    locales: existsSync(join(themeDir, 'locales')) ? readdirSync(join(themeDir, 'locales')) : [],
    appEmbeds: appEmbeds(themeDir),
    themeCount: themes.length + 2,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  store.addBackup({ id, site: cfg.name, stage: 'production', type: 'shopify-theme', location: dir, checksums: manifest.files });
  writeState(root, cfg.name, { store: manifest.store, liveThemeId: manifest.liveThemeId, backupThemeId: manifest.backupThemeId, workThemeId: manifest.workThemeId });
  return { id, dir, manifest };
}

/**
 * Verified means: the backup theme's files match the git snapshot (checksums) and the backup theme previews without
 * Liquid errors (SPEC.md 5.3, CLAUDE.md rule 1).
 */
export async function verifyShopifyBackup(cfg: SiteConfig, store: Store, backupId: string, opts: { cli?: ShopifyCli; preview?: (themeId: string) => Promise<string> } = {}): Promise<{ verified: boolean; mismatches: string[]; liquidErrors: string[] }> {
  const b = store.backups(cfg.name).find((x) => x.id === backupId);
  if (!b) throw new Error(`Unknown backup ${backupId}`);
  const manifest = JSON.parse(readFileSync(join(b.location, 'manifest.json'), 'utf8')) as ShopifyManifest;
  const cli = opts.cli ?? new ShopifyCli(cfg);
  const tmp = mkdtempSync(join(tmpdir(), 'sp-shbk-'));
  try {
    await cli.pull(manifest.backupThemeId, tmp);
    const now = checksumTree(tmp);
    const mismatches = [...new Set([...Object.keys(now), ...Object.keys(manifest.files)])].filter((f) => now[f] !== manifest.files[f]);
    const preview = opts.preview ?? (async (id: string) => {
      const r = await fetch(`https://${manifest.store}/?preview_theme_id=${id}`);
      return r.text();
    });
    const html = await preview(manifest.backupThemeId);
    const liquidErrors = [...html.matchAll(/Liquid (syntax )?error[^<]{0,200}/g)].map((m) => m[0]);
    const verified = mismatches.length === 0 && liquidErrors.length === 0;
    if (verified) store.markBackupVerified(backupId, `shopify-verify-${Date.now()}`);
    return { verified, mismatches, liquidErrors };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface ShopifyDrift {
  changed: string[];
  added: string[];
  removed: string[];
  important: string[];
}

/** Drift control (SPEC.md 5.4, SAFE-17): pulls the live theme now and compares it with the snapshot the work started from. */
export async function shopifyDrift(root: string, cfg: SiteConfig, snapshot: Record<string, string>, opts: { cli?: ShopifyCli } = {}): Promise<ShopifyDrift & { liveDir: string }> {
  const cli = opts.cli ?? new ShopifyCli(cfg);
  const st = readState(root, cfg.name);
  const live = st.liveThemeId ?? String((await cli.live())?.id ?? '');
  const liveDir = mkdtempSync(join(tmpdir(), 'sp-drift-'));
  await cli.pull(live, liveDir);
  const now = checksumTree(liveDir);
  const d = diffTrees(snapshot, now);
  return { ...d, liveDir };
}

export function diffTrees(before: Record<string, string>, after: Record<string, string>): ShopifyDrift {
  const changed = Object.keys(after).filter((f) => before[f] && before[f] !== after[f]);
  const added = Object.keys(after).filter((f) => !before[f]);
  const removed = Object.keys(before).filter((f) => !after[f]);
  const important = [...changed, ...added, ...removed].filter((f) => f === 'config/settings_data.json' || /^templates\/.*\.json$/.test(f) || /^sections\/.*\.json$/.test(f));
  return { changed, added, removed, important };
}


export type { ThemeInfo };
