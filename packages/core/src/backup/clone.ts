import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { SiteConfig } from '../config/site.js';
import { composeHost, type WpHost } from './host.js';
import { readManifest, type WpManifest } from './wordpress.js';
import { backupKey, decryptFile, sha256File } from './crypto.js';
import { run } from '../util/exec.js';
import { paths } from '../util/paths.js';

export const STAGING_GUARD_FILE = fileURLToPath(new URL('../../../wp-agent/staging/speedpilot-staging-guard.php', import.meta.url));
export const AGENT_DIR = fileURLToPath(new URL('../../../wp-agent', import.meta.url));

export interface LocalClone {
  project: string;
  composeFile: string;
  url: string;
  host: WpHost;
  manifest: WpManifest;
  down(removeVolumes?: boolean): Promise<void>;
}

const IMAGE_PHP = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'];

/** Picks the closest wordpress:php<x.y> image to the backup's PHP version. */
export function phpImage(php?: string): string {
  const v = (php ?? '8.3').split('.').slice(0, 2).join('.');
  return `wordpress:php${IMAGE_PHP.includes(v) ? v : '8.3'}`;
}

async function sh(cmd: string, args: string[], timeoutMs = 600_000) {
  const r = await run(cmd, args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 8).join(' ')} failed: ${(r.stderr || r.stdout).slice(-600)}`);
  return r;
}

async function waitHttp(url: string, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/** Verifies every artifact against the manifest checksums before using a backup. */
export async function verifyArtifacts(dir: string, manifest: WpManifest, key?: Buffer): Promise<Record<string, string>> {
  const plain: Record<string, string> = {};
  const work = mkdtempSync(join(tmpdir(), 'sp-restore-'));
  for (const a of manifest.artifacts) {
    let p = join(dir, a.name);
    if (a.encrypted) {
      if (!key) throw new Error('backup is encrypted: SPEEDPILOT_BACKUP_KEY is required to restore it');
      const out = join(work, a.name.replace(/\.enc$/, ''));
      await decryptFile(p, out, key);
      p = out;
    }
    const sum = await sha256File(p);
    if (sum !== a.sha256) throw new Error(`checksum mismatch for ${a.name}: backup is corrupt`);
    plain[a.name.replace(/\.enc$/, '')] = p;
  }
  return plain;
}

/**
 * Restores a WordPress backup into a fresh local Docker WordPress (SPEC.md 5.1 restore test, 5.2 local staging).
 * The staging guard mu-plugin is always installed so the copy cannot send email, call webhooks or take payments.
 */
export async function createLocalClone(root: string, cfg: SiteConfig, backupDir: string, opts: { name: string; port: number; env?: NodeJS.ProcessEnv; stagingAuth?: string }): Promise<LocalClone> {
  const manifest = readManifest(backupDir);
  const files = await verifyArtifacts(backupDir, manifest, backupKey(opts.env));
  const project = `sp-${opts.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  const dir = join(paths.runsDir(root, cfg.name), 'clones', project);
  mkdirSync(dir, { recursive: true });
  const url = `http://localhost:${opts.port}`;
  const extra = [
    `define( 'WP_HOME', '${url}' );`,
    `define( 'WP_SITEURL', '${url}' );`,
    `define( 'WP_ENVIRONMENT_TYPE', 'staging' );`,
    `define( 'SPEEDPILOT_STAGING', true );`,
    `define( 'DISABLE_WP_CRON', true );`,
    `define( 'WP_DEBUG', true ); define( 'WP_DEBUG_LOG', true ); define( 'WP_DEBUG_DISPLAY', false );`,
    cfg.local ? `define( 'SPEEDPILOT_HMAC_SECRET', 'fixture-only-hmac-secret-not-for-production' );` : '',
    cfg.local ? `define( 'SPEEDPILOT_FIXTURE_THIRDPARTY', 'http://127.0.0.1:8890' );` : '',
    opts.stagingAuth ? `define( 'SPEEDPILOT_STAGING_AUTH', '${opts.stagingAuth.replace(/'/g, '')}' );` : '',
  ].filter(Boolean).join('\n');
  const env = {
    WORDPRESS_DB_HOST: 'db',
    WORDPRESS_DB_USER: 'wordpress',
    WORDPRESS_DB_PASSWORD: 'clone-only',
    WORDPRESS_DB_NAME: 'wordpress',
    WORDPRESS_TABLE_PREFIX: manifest.tablePrefix,
    WORDPRESS_CONFIG_EXTRA: extra,
    HOME: '/tmp',
  };
  const guardMount = `${STAGING_GUARD_FILE}:/var/www/html/wp-content/mu-plugins/speedpilot-staging-guard.php:ro`;
  const compose = {
    name: project,
    services: {
      db: { image: 'mariadb:11', environment: { MARIADB_DATABASE: 'wordpress', MARIADB_USER: 'wordpress', MARIADB_PASSWORD: 'clone-only', MARIADB_ROOT_PASSWORD: 'clone-only-root' }, volumes: ['db_data:/var/lib/mysql'], healthcheck: { test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'], interval: '3s', retries: 40 } },
      wordpress: { image: phpImage(manifest.php), depends_on: { db: { condition: 'service_healthy' } }, ports: [`${opts.port}:80`], environment: env, volumes: ['wp_data:/var/www/html', guardMount] },
      cli: { image: 'wordpress:cli-php8.3', user: '33:33', depends_on: ['wordpress'], environment: env, volumes: ['wp_data:/var/www/html', guardMount], entrypoint: ['sleep', 'infinity'] },
    },
    volumes: { db_data: {}, wp_data: {} },
  };
  const composeFile = join(dir, 'compose.yaml');
  writeFileSync(composeFile, YAML.stringify(compose));
  const base = ['compose', '-f', composeFile, '-p', project];
  await sh('docker', [...base, 'up', '-d', '--wait', 'db', 'wordpress']);
  await sh('docker', [...base, 'up', '-d', 'cli']);
  await waitHttp(`${url}/wp-includes/images/blank.gif`).catch(() => undefined);
  const host = composeHost({ composeFile, project, stage: 'staging', url, root, cfg, label: `local clone ${project}` });

  // files first (keep the clone's own wp-config.php), then the database
  await host.streamIn(`tar -xzf - -C /var/www/html --exclude=wp-config.php --exclude=wp-content/mu-plugins/speedpilot-staging-guard.php && (chown -R www-data:www-data /var/www/html/wp-content 2>/dev/null || true)`, files['files.tar.gz']!);
  await host.cliStreamIn('wp db import - --quiet', files['database.sql']!);
  // URLs: dry run first, then the real replacement (SPEC.md 5.2)
  const from = manifest.url.replace(/\/$/, '');
  if (from !== url) {
    const dry = await host.wp.text(['search-replace', from, url, '--all-tables', '--precise', '--dry-run', '--report-changed-only']);
    if (!/Success|replacements/i.test(dry) && !/0 replacements/.test(dry)) throw new Error(`search-replace dry run failed: ${dry.slice(0, 300)}`);
    await host.wp.text(['search-replace', from, url, '--all-tables', '--precise', '--report-changed-only']);
  }
  await host.wp.raw(['cache', 'flush']).catch(() => undefined);
  await host.wp.raw(['rewrite', 'flush']).catch(() => undefined);
  for (const p of Object.values(files)) if (p.includes('sp-restore-')) rmSync(dirname(p), { recursive: true, force: true });
  return {
    project,
    composeFile,
    url,
    host,
    manifest,
    down: async (removeVolumes = true) => {
      await run('docker', [...base, 'down', ...(removeVolumes ? ['-v'] : [])], { timeoutMs: 300_000 });
    },
  };
}

export function cloneExists(root: string, site: string, project: string): boolean {
  return existsSync(join(paths.runsDir(root, site), 'clones', project, 'compose.yaml'));
}
