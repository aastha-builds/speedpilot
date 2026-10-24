import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Store, loadSite, fixtureHost, backupWordPress, restoreTest, decideMode, parseDf, prepareWordPressStaging, wpState, wpDrift,
  writeApproval, ApprovalError, encryptFile, decryptFile, sha256File, type WpHost,
} from '@speedpilot/core';
import { FakeShopifyStore, backupShopify, verifyShopifyBackup, shopifyDrift, diffTrees, checksumTree } from '@speedpilot/shopify';
import { REPO, tempRoot, wpUp } from './helpers.js';

describe('disk space check (SAFE-33)', () => {
  it('writes on the server only when at least 20% stays free, otherwise streams', () => {
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 1000000 500000 500000 50% /')).toEqual({ totalBytes: 1024000000, freeBytes: 512000000 });
    expect(decideMode(100e9, 50e9, 10e9).mode).toBe('server-temp');
    expect(decideMode(100e9, 25e9, 10e9).mode).toBe('stream');
    expect(decideMode(100e9, 5e9, 1e9).mode).toBe('stream');
  });

  it('streams the backup straight off the server when space is tight (no temporary file on the server)', async () => {
    const commands: string[] = [];
    const files = new Map<string, string>();
    const fakeHost: WpHost = {
      label: 'fake', stage: 'production', docroot: '/srv/www', url: 'https://shop.example',
      shell: async (cmd) => {
        commands.push(cmd);
        if (cmd.startsWith('df -Pk')) return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1000000 900000 100000 90% /', stderr: '' };
        if (cmd.startsWith('du -sk')) return { code: 0, stdout: '50000\n', stderr: '' };
        if (cmd.includes('ls -a')) return { code: 0, stdout: 'wp-content\nwp-config.php\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      cliShell: async (cmd) => { commands.push(cmd); return { code: 0, stdout: '', stderr: '' }; },
      streamOut: async (cmd, file) => { commands.push(`STREAM ${cmd}`); writeFileSync(file, 'x'.repeat(500)); files.set(file, cmd); return 0; },
      cliStreamOut: async (cmd, file) => { commands.push(`STREAM ${cmd}`); writeFileSync(file, '-- dump\n'.repeat(50)); return 0; },
      streamIn: async () => 0,
      cliStreamIn: async () => 0,
      wp: {
        text: async (args: string[]) => (args[0] === 'db' && args[1] === 'size' ? '40000000' : args[0] === 'core' ? '7.1.3' : 'null'),
        json: async () => [],
        sql: async (q: string) => (q.startsWith('SHOW TABLES LIKE') ? [['wp_options']] : q === 'SHOW TABLES' ? [['wp_options']] : q.startsWith('CHECKSUM') ? [['wp_options', '123']] : [['5']]),
        raw: async () => ({ code: 0, stdout: '', stderr: '' }),
      } as never,
    };
    const root = tempRoot(['fixture-wp']);
    const store = new Store(root, ':memory:');
    store.upsertSite(loadSite(root, 'fixture-wp'));
    const key = randomBytes(32).toString('base64');
    const r = await backupWordPress({ ...loadSite(root, 'fixture-wp'), local: false }, 'production', { host: fakeHost, store, backupsDir: join(root, 'backups'), env: { SPEEDPILOT_BACKUP_KEY: key } });
    expect(commands[0]).toMatch(/^df -Pk \/srv\/www/);
    expect(r.manifest.disk.mode).toBe('stream');
    expect(commands.some((c) => c.includes('/tmp/speedpilot-'))).toBe(false);
    expect(commands.filter((c) => c.startsWith('STREAM')).length).toBeGreaterThanOrEqual(2);
    expect(r.manifest.artifacts.every((a) => a.encrypted)).toBe(true);
    expect(existsSync(join(r.dir, 'database.sql'))).toBe(false);
    store.close();
  });

  it('refuses an unencrypted backup of a real site', async () => {
    const root = tempRoot(['fixture-wp']);
    const store = new Store(root, ':memory:');
    const host = { shell: async () => ({ code: 0, stdout: 'x 100 0 100 0% /', stderr: '' }), cliShell: async () => ({ code: 0, stdout: '', stderr: '' }), streamOut: async (_c: string, f: string) => { writeFileSync(f, 'x'.repeat(200)); return 0; }, cliStreamOut: async (_c: string, f: string) => { writeFileSync(f, 'x'.repeat(200)); return 0; }, docroot: '/x', url: 'https://x', wp: { text: async () => '0', json: async () => [], sql: async () => [], raw: async () => ({ code: 0, stdout: '', stderr: '' }) } } as never;
    await expect(backupWordPress({ ...loadSite(root, 'fixture-wp'), local: false }, 'production', { host, store, backupsDir: join(root, 'b'), env: {}, diskOverride: decideMode(100, 90, 1) })).rejects.toThrow(/encrypted at rest/);
  });

  it('encrypts and decrypts backups (AES-256-GCM)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sp-enc-'));
    writeFileSync(join(d, 'a.sql'), 'secret customer data '.repeat(1000));
    const key = randomBytes(32);
    await encryptFile(join(d, 'a.sql'), join(d, 'a.enc'), key);
    expect(readFileSync(join(d, 'a.enc')).includes(Buffer.from('secret customer'))).toBe(false);
    await decryptFile(join(d, 'a.enc'), join(d, 'b.sql'), key);
    expect(await sha256File(join(d, 'b.sql'))).toBe(await sha256File(join(d, 'a.sql')));
  });
});

describe('Shopify backup, work theme and drift (fake store)', () => {
  const store = new FakeShopifyStore(join(REPO, 'fixtures/shopify/theme'));
  afterAll(() => store.cleanup());
  it('checks the theme count, pulls into git, duplicates backup and work themes, verifies, and catches drift', async () => {
    const root = tempRoot(['fixture-shopify']);
    const cfg = loadSite(root, 'fixture-shopify');
    const db = new Store(root, ':memory:');
    db.upsertSite(cfg);
    const { ShopifyCli } = await import('@speedpilot/shopify');
    const cli = new ShopifyCli(cfg, store.runner);
    const r = await backupShopify(root, cfg, db, { cli, backupsDir: join(root, 'backups') });
    expect(store.themes.map((t) => t.name)).toEqual(expect.arrayContaining([expect.stringMatching(/^SpeedPilot backup /), expect.stringMatching(/^SpeedPilot work /)]));
    expect(r.manifest.workThemeId).not.toBe(r.manifest.liveThemeId);
    expect(r.manifest.appEmbeds.some((e) => e.app === 'oldreviews')).toBe(true);
    const state = JSON.parse(readFileSync(join(root, 'runs/fixture-shopify/state.json'), 'utf8'));
    expect(state.workThemeId).toBe(r.manifest.workThemeId);
    const v = await verifyShopifyBackup(cfg, db, r.id, { cli, preview: async () => '<html>ok</html>' });
    expect(v.verified).toBe(true);
    expect(db.backups(cfg.name)[0]!.restoreTested).toBe(true);
    const bad = await verifyShopifyBackup(cfg, db, r.id, { cli, preview: async () => 'Liquid error (sections/hero line 3): x' });
    expect(bad.verified).toBe(false);
    // the merchant edits the live theme after the snapshot
    const liveDir = store.dir(store.live().id);
    const sd = join(liveDir, 'config/settings_data.json');
    writeFileSync(sd, readFileSync(sd, 'utf8').replace('"slider_autoplay": true', '"slider_autoplay": false'));
    const drift = await shopifyDrift(root, cfg, r.manifest.files, { cli });
    expect(drift.changed).toContain('config/settings_data.json');
    expect(drift.important).toContain('config/settings_data.json');
    expect(diffTrees({ a: '1' }, { a: '1' })).toEqual({ changed: [], added: [], removed: [], important: [] });
  });
  it('never deletes a theme when the library is full', async () => {
    const full = new FakeShopifyStore(join(REPO, 'fixtures/shopify/theme'), 19);
    const root = tempRoot(['fixture-shopify']);
    const cfg = loadSite(root, 'fixture-shopify');
    const db = new Store(root, ':memory:');
    const { ShopifyCli } = await import('@speedpilot/shopify');
    await expect(backupShopify(root, cfg, db, { cli: new ShopifyCli(cfg, full.runner), backupsDir: join(root, 'b') })).rejects.toThrow(/never deletes a theme/);
    expect(full.calls.some((c) => c[1] === 'delete')).toBe(false);
    full.cleanup();
  });
});

describe.skipIf(!wpUp)('WordPress backup, restore test, staging and drift on the fixture', () => {
  it('backs up the fixture, restores it into a fresh WordPress, passes the smoke flows, and prepares a neutralized staging copy', async () => {
    const root = tempRoot(['fixture-wp']);
    cpSync(join(REPO, 'runs/fixture-wp/state.json'), join(root, 'runs/fixture-wp/state.json'), { force: true });
    const cfg = loadSite(root, 'fixture-wp');
    const store = new Store(root);
    store.upsertSite(cfg);
    const host = fixtureHost(REPO, cfg);
    const before = await wpState(host);
    const b = await backupWordPress(cfg, 'local', { host, store, backupsDir: join(root, 'backups') });
    expect(b.manifest.tables.length).toBeGreaterThan(10);
    expect(b.manifest.plugins.some((p) => p.name === 'woocommerce')).toBe(true);
    expect(b.manifest.artifacts.map((a) => a.name)).toEqual(['database.sql', 'files.tar.gz']);
    const rt = await restoreTest(root, cfg, store, b.id, { port: 8899 });
    expect(rt.smoke.pages.every((p) => p.pass), JSON.stringify(rt.smoke.pages)).toBe(true);
    expect(rt.smoke.flows.filter((f) => !f.pass), JSON.stringify(rt.smoke.flows)).toEqual([]);
    expect(rt.verified).toBe(true);
    expect(store.backups(cfg.name)[0]!.restoreTested).toBe(true);

    // staging needs the staging-prep approval: a local clone counts as local, but the executor still checks it
    const st = await prepareWordPressStaging(root, cfg, store, { port: 8897 });
    try {
      expect(st.checks.filter((c) => !c.pass), JSON.stringify(st.checks)).toEqual([]);
      expect(st.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['email never leaves staging', 'webhooks and outgoing HTTP are blocked', 'only test-mode or offline payment gateways remain']));
    } finally {
      const { run } = await import('@speedpilot/core');
      await run('docker', ['compose', '-p', st.project!, '-f', join(root, 'runs/fixture-wp/clones', st.project!, 'compose.yaml'), 'down', '-v'], { timeoutMs: 300_000 });
    }

    // drift: nothing changed, then a plugin is deactivated
    expect(wpDrift(before, await wpState(host))).toEqual([]);
    await host.wp.raw(['plugin', 'deactivate', 'smart-slider-3']);
    try {
      const d = wpDrift(before, await wpState(host));
      expect(d.some((x) => x.kind === 'plugin' && x.name === 'smart-slider-3')).toBe(true);
    } finally {
      await host.wp.raw(['plugin', 'activate', 'smart-slider-3']);
    }
    store.close();
  }, 900_000);

  it('the executor refuses staging preparation on a remote stage without approval', async () => {
    const root = tempRoot(['fixture-wp']);
    const cfg = { ...loadSite(root, 'fixture-wp'), local: false, stagingUrl: 'https://staging.shop.example/' };
    const store = new Store(root, ':memory:');
    await expect(prepareWordPressStaging(root, cfg, store)).rejects.toThrow(ApprovalError);
    writeApproval(root, { site: cfg.name, stage: 'staging', operation: 'staging-prep', items: ['all'], approvedBy: 'Test' });
    await expect(prepareWordPressStaging(root, cfg, store)).rejects.toThrow(/No verified backup/);
  });
});
