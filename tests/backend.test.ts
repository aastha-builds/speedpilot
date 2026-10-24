import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { loadSite, collectWordPressBackend, wpCommandIsReadOnly, WpCli, agentToken, parseServerTiming } from '@speedpilot/core';
import { collectShopifyBackend, startPreview, ShopifyCli, type PreviewServer } from '@speedpilot/shopify';
import { REPO, tempRoot, wpUp } from './helpers.js';

describe('WP-CLI wrapper', () => {
  it('refuses writes on remote stages and allows read-only commands', async () => {
    const root = tempRoot();
    const cfg = { ...loadSite(REPO, 'fixture-wp'), local: false };
    const calls: string[][] = [];
    const wp = new WpCli(root, cfg, 'production', async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: '7.1.3', stderr: '' };
    });
    expect(await wp.text(['core', 'version'])).toBe('7.1.3');
    expect(calls[0]).toEqual(['wp', '@production', 'core', 'version']);
    await expect(wp.raw(['option', 'update', 'x', 'y'])).rejects.toThrow(/Refusing write/);
    await expect(wp.sql('DELETE FROM wp_posts')).rejects.toThrow(/read-only/);
    expect(wpCommandIsReadOnly(['eval', 'echo 1;'])).toBe(false);
    expect(wpCommandIsReadOnly(['db', 'query', 'SELECT 1'])).toBe(true);
  });
  it('builds agent tokens and parses Server-Timing', () => {
    expect(agentToken('s'.repeat(20), 'diag', 60, 1_000_000_000_000)).toMatch(/^1000000060\.diag\.[0-9a-f]{64}$/);
    expect(parseServerTiming('sp-total;dur=12.5, sp-init;dur=1')).toEqual({ 'sp-total': 12.5, 'sp-init': 1 });
  });
});

describe('Shopify CLI wrapper', () => {
  it('never pushes live and only pushes to the recorded work theme', async () => {
    const cfg = loadSite(REPO, 'fixture-shopify');
    const calls: string[][] = [];
    const cli = new ShopifyCli(cfg, async (cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify([{ id: 999, name: 'Live', role: 'live' }, { id: 111, name: 'Work', role: 'unpublished' }]), stderr: '' };
    });
    await expect(cli.pushToWorkTheme('999', '111', '/tmp/t', ['layout/theme.liquid'])).rejects.toThrow(/recorded work theme/);
    await expect(cli.pushToWorkTheme('999', '999', '/tmp/t', [])).rejects.toThrow(/live theme/);
    await expect(cli.exec(['theme', 'push', '--theme', '111', '--live'])).rejects.toThrow(/never/);
    await cli.pushToWorkTheme('111', '111', '/tmp/t', ['layout/theme.liquid']);
    const push = calls.find((c) => c[1] === 'push')!;
    expect(push).toContain('--nodelete');
    expect(push).not.toContain('--live');
    expect(push.slice(push.indexOf('--theme'), push.indexOf('--theme') + 2)).toEqual(['--theme', '111']);
  });
});

describe('Shopify backend on the fixture theme', () => {
  let srv: PreviewServer;
  afterAll(() => srv?.close());
  it('finds the parser-blocking script, the slow Liquid loop and the leftover app snippet', async () => {
    srv = await startPreview({ themeDir: join(REPO, 'fixtures/shopify/theme') });
    const cfg = loadSite(REPO, 'fixture-shopify');
    const runDir = mkdtempSync(join(tmpdir(), 'sp-shb-'));
    const failedReq = { url: 'https://cdn.oldreviews-app.example/widget.js', type: 'script', method: 'GET', status: null, transferBytes: 0, decodedBytes: 0, cookieBytes: 0, owner: { id: 'third-party:cdn.oldreviews-app.example', kind: 'third-party' as const, name: 'x', via: 'domain' as const }, failed: 'net::ERR_NAME_NOT_RESOLVED' };
    const b = await collectShopifyBackend(cfg, 'local', [srv.url + '/', srv.url + '/products/product-1'], { runDir, themeDir: join(REPO, 'fixtures/shopify/theme'), previewUrl: srv.url, requests: [failedReq] });
    expect(b.themeCheck.filter((o) => o.check === 'ParserBlockingScript' && o.file === 'layout/theme.liquid').length).toBeGreaterThanOrEqual(1);
    const home = b.profile.find((p) => p.url.endsWith('/'))!;
    expect(home.hotSpots[0]!.file).toBe('sections/featured-collection.liquid');
    expect(home.hotSpots[0]!.ms).toBeGreaterThan(5);
    expect(b.leftovers.some((l) => l.file === 'snippets/oldreviews-app-widget.liquid' && l.renderedIn.includes('layout/theme.liquid'))).toBe(true);
    expect(b.leftovers.some((l) => l.file.startsWith('config/settings_data.json'))).toBe(true);
    expect(b.appEmbeds.find((e) => e.app === 'oldreviews')?.enabled).toBe(true);
    expect(b.theme.os2).toBe(true);
    expect(b.sectionsPerTemplate.index).toEqual(['hero', 'featured-collection']);
    expect(spawnSync('git', ['log', '--oneline'], { cwd: b.themeDir, encoding: 'utf8' }).stdout).toMatch(/snapshot/);
  }, 120_000);
});

describe.skipIf(!wpUp)('WordPress backend on the fixture (needs pnpm fixtures:wp up)', () => {
  it('shows the slow query with its caller, 2 MB of autoload with owners, CF7 and cart fragments on every page', async () => {
    const cfg = loadSite(REPO, 'fixture-wp');
    const urls = ['http://localhost:8888/', 'http://localhost:8888/about/', 'http://localhost:8888/blog/'];
    const b = await collectWordPressBackend(REPO, cfg, 'local', urls);
    const home = b.perUrl.find((u) => u.url === urls[0])!;
    const slow = home.diag!.queries.find((q) => q.ms >= 50);
    expect(slow?.caller.function).toBe('spf_related_posts');
    expect(slow?.caller.owner).toMatch(/^theme:speedpilot-fixture/);
    expect(b.autoload!.total_bytes).toBeGreaterThan(2_000_000);
    const owners = Object.fromEntries(b.autoload!.top.map((t) => [t.name, t.owner]));
    expect(owners.oldstats_plugin_data).toMatch(/^unknown:/);
    expect(owners.smartslider_cache_1).toBe('plugin:smart-slider-3');
    expect(owners.elementor_remote_info_cache).toBe('plugin:elementor');
    for (const u of b.perUrl) {
      expect(u.diag!.scripts.some((s) => s.handle === 'contact-form-7'), u.url).toBe(true);
      expect(u.diag!.scripts.some((s) => s.handle === 'wc-cart-fragments'), u.url).toBe(true);
    }
    expect(home.serverTiming['sp-total']).toBeGreaterThan(0);
    expect(b.plugins.some((p) => p.name === 'woocommerce' && p.status === 'active')).toBe(true);
    expect(b.database.tables.length).toBeGreaterThan(10);
    expect(b.adminTimings?.length).toBe(4);
  }, 180_000);
});
