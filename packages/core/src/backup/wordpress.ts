import { mkdirSync, statSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../config/site.js';
import type { Store, Stage } from '../store/store.js';
import type { WpHost } from './host.js';
import { sha256File, backupKey, encryptFile } from './crypto.js';
import { log } from '../log.js';

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
  estimatedBytes: number;
  /** Free share left if the backup were written on the server. */
  freeAfterShare: number;
  mode: 'server-temp' | 'stream';
}

export interface BackupArtifact {
  name: string;
  bytes: number;
  sha256: string;
  encrypted: boolean;
}

export interface WpManifest {
  site: string;
  stage: Stage;
  createdAt: string;
  url: string;
  wordpress?: string;
  php?: string;
  plugins: Array<{ name: string; status: string; version: string }>;
  themes: Array<{ name: string; status: string; version: string }>;
  activeTheme?: string;
  parentTheme?: string;
  options: Record<string, unknown>;
  cron: unknown[];
  muPlugins: string[];
  dropins: string[];
  tables: Array<{ name: string; rows: number; checksum: string | null }>;
  tablePrefix: string;
  uploadsChecksums?: string;
  artifacts: BackupArtifact[];
  disk: DiskInfo;
}

export interface BackupResult {
  id: string;
  dir: string;
  manifest: WpManifest;
}

export const KEY_OPTIONS = ['siteurl', 'home', 'permalink_structure', 'active_plugins', 'stylesheet', 'template', 'blog_public', 'woocommerce_db_version', 'elementor_version', 'elementor_css_print_method'];

/** Parses `df -Pk <path>` output. */
export function parseDf(out: string): { totalBytes: number; freeBytes: number } {
  const line = out.trim().split('\n').pop() ?? '';
  const parts = line.trim().split(/\s+/);
  const total = Number(parts[1]) * 1024;
  const free = Number(parts[3]) * 1024;
  if (!Number.isFinite(total) || !Number.isFinite(free)) throw new Error(`cannot parse df output: ${out.slice(0, 200)}`);
  return { totalBytes: total, freeBytes: free };
}

/** Decides where the backup is written: on the server first only when it leaves at least 20% free (SPEC 5.1, SAFE-33). */
export function decideMode(totalBytes: number, freeBytes: number, estimatedBytes: number): DiskInfo {
  const freeAfterShare = totalBytes > 0 ? (freeBytes - estimatedBytes) / totalBytes : 0;
  return { totalBytes, freeBytes, estimatedBytes, freeAfterShare: Math.round(freeAfterShare * 1000) / 1000, mode: freeAfterShare >= 0.2 ? 'server-temp' : 'stream' };
}

export async function checkDisk(host: WpHost): Promise<DiskInfo> {
  const df = await host.shell(`df -Pk ${host.docroot}`);
  if (df.code !== 0) throw new Error(`df failed: ${df.stderr}`);
  const { totalBytes, freeBytes } = parseDf(df.stdout);
  const dbSize = Number((await host.wp.text(['db', 'size', '--size_format=b']).catch(() => '0')).replace(/[^0-9]/g, '')) || 0;
  const du = await host.shell(`du -sk ${host.docroot}/wp-content 2>/dev/null | cut -f1`);
  const filesBytes = (Number(du.stdout.trim()) || 0) * 1024;
  // compressed archives are smaller; count the raw size to stay on the safe side
  return decideMode(totalBytes, freeBytes, dbSize + filesBytes);
}

const CACHE_EXCLUDES = ['wp-content/cache', 'wp-content/et-cache', 'wp-content/uploads/cache', 'wp-content/litespeed', 'wp-content/w3tc-config', 'wp-content/upgrade', 'wp-content/backups', 'wp-content/updraft', 'wp-content/ai1wm-backups', 'wp-content/debug.log'];

export interface BackupOptions {
  host: WpHost;
  store: Store;
  backupsDir: string;
  /** Large media libraries: verify uploads against a checksum manifest instead of archiving them. */
  skipUploads?: boolean;
  /** Test hook: overrides the disk decision. */
  diskOverride?: DiskInfo;
  env?: NodeJS.ProcessEnv;
}

/** WordPress backup (SPEC.md 5.1). Requires no approval: it only reads the site, after checking free disk space. */
export async function backupWordPress(cfg: SiteConfig, stage: Stage, o: BackupOptions): Promise<BackupResult> {
  const id = `bk-${cfg.name}-${stage}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const dir = join(o.backupsDir, cfg.name, id);
  mkdirSync(dir, { recursive: true });
  const disk = o.diskOverride ?? (await checkDisk(o.host));
  log.info({ id, mode: disk.mode, freeAfterShare: disk.freeAfterShare }, 'backup disk check');
  const wp = o.host.wp;

  // Database
  const prefix = (await wp.sql("SHOW TABLES LIKE '%options'").catch(() => [] as string[][]))[0]?.[0]?.replace(/options$/, '') ?? 'wp_';
  const dbFile = join(dir, 'database.sql');
  const exportCmd = `cd ${o.host.docroot} && wp db export - --single-transaction --quick --allow-root 2>/dev/null`;
  if (disk.mode === 'stream') {
    await o.host.cliStreamOut(exportCmd, dbFile);
  } else {
    const tmp = `/tmp/speedpilot-${id}.sql`;
    const r = await o.host.cliShell(`cd ${o.host.docroot} && wp db export ${tmp} --single-transaction --quick --allow-root`);
    if (r.code !== 0) throw new Error(`db export failed: ${r.stderr.slice(0, 300)}`);
    try {
      await o.host.cliStreamOut(`cat ${tmp}`, dbFile);
    } finally {
      await o.host.cliShell(`rm -f ${tmp}`);
    }
  }
  if (!existsSync(dbFile) || statSync(dbFile).size < 100) throw new Error('database export is empty');

  // Per-table row counts and checksums
  const tableNames = (await wp.sql('SHOW TABLES')).map((r) => r[0]!).filter(Boolean);
  const tables: WpManifest['tables'] = [];
  for (const t of tableNames) {
    const rows = Number((await wp.sql(`SELECT COUNT(*) FROM \`${t}\``))[0]?.[0] ?? 0);
    const ck = (await wp.sql(`CHECKSUM TABLE \`${t}\``).catch(() => [] as string[][]))[0]?.[1] ?? null;
    tables.push({ name: t, rows, checksum: ck });
  }

  // Files
  const present = (await o.host.shell(`cd ${o.host.docroot} && ls -a`)).stdout.split('\n').map((s) => s.trim());
  const include = ['wp-content', 'wp-config.php', '.htaccess', '.user.ini', 'php.ini'].filter((f) => present.includes(f));
  const excludes = [...CACHE_EXCLUDES, ...(o.skipUploads ? ['wp-content/uploads'] : [])].map((e) => `--exclude=${e}`).join(' ');
  const filesTar = join(dir, 'files.tar.gz');
  const tarCmd = `cd ${o.host.docroot} && tar -czf - ${excludes} ${include.join(' ')}`;
  if (disk.mode === 'stream') await o.host.streamOut(tarCmd, filesTar);
  else {
    const tmp = `/tmp/speedpilot-${id}.tar.gz`;
    const r = await o.host.shell(`${tarCmd.replace('tar -czf -', `tar -czf ${tmp}`)}`);
    if (r.code !== 0) throw new Error(`files archive failed: ${r.stderr.slice(0, 300)}`);
    try {
      await o.host.streamOut(`cat ${tmp}`, filesTar);
    } finally {
      await o.host.shell(`rm -f ${tmp}`);
    }
  }
  let uploadsChecksums: string | undefined;
  if (o.skipUploads) {
    const f = join(dir, 'uploads.sha256');
    await o.host.streamOut(`cd ${o.host.docroot} && find wp-content/uploads -type f -exec sha256sum {} +`, f);
    uploadsChecksums = 'uploads.sha256';
  }

  // Manifest
  const opt = async (n: string) => wp.text(['option', 'get', n, '--format=json']).then((v) => JSON.parse(v) as unknown).catch(() => null);
  const options: Record<string, unknown> = {};
  for (const n of KEY_OPTIONS) options[n] = await opt(n);
  const plugins = await wp.json<Array<{ name: string; status: string; version: string }>>(['plugin', 'list', '--fields=name,status,version']).catch(() => []);
  const manifest: WpManifest = {
    site: cfg.name,
    stage,
    createdAt: new Date().toISOString(),
    url: o.host.url,
    wordpress: await wp.text(['core', 'version']).catch(() => undefined),
    php: (await o.host.shell('php -r "echo PHP_VERSION;"')).stdout.trim() || undefined,
    plugins: plugins.filter((p) => p.status !== 'must-use' && p.status !== 'dropin'),
    themes: await wp.json<Array<{ name: string; status: string; version: string }>>(['theme', 'list', '--fields=name,status,version']).catch(() => []),
    activeTheme: options.stylesheet as string | undefined,
    parentTheme: options.template as string | undefined,
    options,
    cron: await wp.json<unknown[]>(['cron', 'event', 'list', '--fields=hook,next_run_gmt,recurrence']).catch(() => []),
    muPlugins: plugins.filter((p) => p.status === 'must-use').map((p) => p.name),
    dropins: plugins.filter((p) => p.status === 'dropin').map((p) => p.name),
    tables,
    tablePrefix: prefix,
    uploadsChecksums,
    artifacts: [],
    disk,
  };

  // Checksums, then encryption at rest (SPEC.md 12)
  const key = backupKey(o.env);
  for (const name of ['database.sql', 'files.tar.gz', ...(uploadsChecksums ? [uploadsChecksums] : [])]) {
    const p = join(dir, name);
    const sum = await sha256File(p);
    let encrypted = false;
    if (key) {
      await encryptFile(p, `${p}.enc`, key);
      rmSync(p);
      encrypted = true;
    }
    manifest.artifacts.push({ name: encrypted ? `${name}.enc` : name, bytes: statSync(encrypted ? `${p}.enc` : p).size, sha256: sum, encrypted });
  }
  if (!key) log.warn({ id }, 'SPEEDPILOT_BACKUP_KEY is not set: backup stored unencrypted (allowed for local fixtures only)');
  if (!key && !cfg.local) throw new Error('Backups contain customer data and must be encrypted at rest: set SPEEDPILOT_BACKUP_KEY in .env.');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  o.store.addBackup({ id, site: cfg.name, stage, type: 'wordpress-full', location: dir, checksums: Object.fromEntries(manifest.artifacts.map((a) => [a.name, a.sha256])) });
  return { id, dir, manifest };
}

export function readManifest(dir: string): WpManifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as WpManifest;
}

/** Deletes backups older than the agreed retention (default 30 days, SPEC.md 12). */
export function pruneBackups(store: Store, site: string, days = 30, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const b of store.backups(site)) {
    if (now - Date.parse(b.createdAt) > days * 86_400_000 && existsSync(b.location)) {
      rmSync(b.location, { recursive: true, force: true });
      removed.push(b.id);
    }
  }
  return removed;
}
