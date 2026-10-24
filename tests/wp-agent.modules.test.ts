import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadSite, WpCli, AgentClient, FIXTURE_HMAC_SECRET, summarize } from '@speedpilot/core';
import { readFlags, type FlagsDoc } from '@speedpilot/engine';
import { REPO, wpUp } from './helpers.js';

/** Realistic settings for every module (the fixture's own handles and assets). */
const ALL_ON: Record<string, Record<string, unknown>> = {
  'asset-control': { strategy: { 'spf-footer-year': 'defer', 'smartslider-frontend': 'defer' }, dequeue: [{ handle: 'spf-unused-lib', type: 'script' }] },
  lcp: { match: 'hero.jpg', preload: true, href: 'http://localhost:8888/wp-content/themes/speedpilot-fixture/assets/img/hero.jpg' },
  images: { dimensions: { 'thumb-1.jpg': [1200, 800] }, eagerCount: 1, lazyIframes: true, skip: ['hero.jpg'] },
  fonts: { dequeue: ['spf-google-fonts'], css: '@font-face{font-family:"Roboto";font-weight:400;font-display:swap;src:url(/wp-content/uploads/speedpilot/fonts/roboto-400-normal-latin.woff2) format("woff2")}', preload: ['/wp-content/uploads/speedpilot/fonts/roboto-400-normal-latin.woff2'], fallbackCss: '' },
  'core-extras': { emoji: true, oembed: true, jqueryMigrate: true, dashicons: true, blockCss: true, commentReply: true, heartbeat: true },
  'third-parties': { delay: { 'spf-chat-widget': 'interaction' }, facades: { youtube: true } },
  css: { critical: { home: 'body{margin:0}' }, async: ['spf-theme'], extraCss: '.promo-banner{height:60px}' },
  'resource-hints': { preconnect: [], dnsPrefetch: ['https://example.org'], remove: ['fonts.googleapis.com'] },
  speculative: { mode: 'prefetch', eagerness: 'conservative' },
  'plugin-cf7': { rules: { urls: ['/contact/'] } },
  'plugin-woocommerce': { cartFragments: { keep: [] } },
  'plugin-elementor': {},
  'query-cache': { rules: [{ match: { spf_related: 1 }, cap: 12, orderby: 'date', ttl: 600 }] },
  'interaction-yield': { handlers: [{ name: 'spfHeavyClickHandler', type: 'click' }] },
};

const compose = join(REPO, 'fixtures/wp/compose.yaml');
const bench = (htmlFile: string) => JSON.parse(execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', 'cli', 'wp', 'eval-file', '/var/www/agent-tests/overhead-bench.php', htmlFile], { encoding: 'utf8' }).trim().split('\n').pop()!) as { enabled: string[]; agentMs: number; callbacksMs: number; queriesAdded: number };

describe.skipIf(!wpUp)('WordPress agent optimization modules', () => {
  const wp = new WpCli(REPO, loadSite(REPO, 'fixture-wp'), 'local', undefined, true);
  const agent = new AgentClient('http://localhost:8888', FIXTURE_HMAC_SECRET);
  let saved: FlagsDoc;
  const page = async (url = 'http://localhost:8888/') => (await fetch(url, { headers: { 'cache-control': 'no-cache' } })).text();
  const setAll = async (on: boolean) => {
    for (const [k, s] of Object.entries(ALL_ON)) {
      if (on) await wp.text(['speedpilot', 'enable', k, `--settings=${JSON.stringify(s)}`, '--reason=test all on']);
      else await wp.text(['speedpilot', 'disable', k, '--reason=test all off']);
    }
  };
  const writeDoc = async (doc: FlagsDoc) => {
    const f = join(REPO, 'packages/wp-agent/tests/.flags-restore.json');
    writeFileSync(f, JSON.stringify(doc));
    await wp.text(['speedpilot', 'import', '/var/www/agent-tests/.flags-restore.json', '--reason=test restore']);
  };
  beforeAll(async () => {
    saved = await readFlags(wp);
  });
  afterAll(async () => {
    if (saved) await writeDoc(saved);
  });

  it('every module turns on with its settings and changes the page', async () => {
    await setAll(true);
    const html = await page();
    const hero = /<img[^>]*hero\.jpg[^>]*>/.exec(html)?.[0] ?? '';
    expect(hero).toContain('fetchpriority="high"');
    expect(hero).not.toContain('loading="lazy"');
    expect(html).toMatch(/rel=["']preload["'][^>]*hero\.jpg|hero\.jpg[^>]*rel=["']preload["']/);
    expect(html).not.toMatch(/unused-lib\.js/);
    expect(html).toMatch(/footer-year\.js[^>]*defer|defer[^>]*footer-year\.js/);
    expect(html).not.toMatch(/fonts\.googleapis\.com\/css2/);
    expect(html).toContain('speedpilot-fonts');
    expect(html).not.toMatch(/wp-emoji-release/);
    expect(html).toMatch(/type="text\/speedpilot-delayed"[^>]*chat\/widget\.js|chat\/widget\.js[^>]*type="text\/speedpilot-delayed"/);
    expect(html).toContain('speedpilot-delay-loader');
    expect(html).toContain('data-speedpilot-facade');
    expect(html).toContain('speedpilot-critical-css');
    expect(html).toContain('speedpilot-css-fixes');
    expect(html).not.toMatch(/contact-form-7\/includes\/js/);
    expect(await page('http://localhost:8888/contact/')).toMatch(/contact-form-7\/includes\/js/);
    expect(html).not.toMatch(/cart-fragments/);
    expect(html).toContain('speedpilot-interaction-yield');
  }, 120_000);

  it('adds under 2 ms and zero database queries per request, with all flags off and with all flags on', async () => {
    const dir = join(REPO, 'packages/wp-agent/tests');
    const results: Record<string, { bootMs: number; callbacksMs: number; queriesAdded: number; total: number }> = {};
    for (const state of ['off', 'on'] as const) {
      await setAll(state === 'on');
      const html = await page();
      writeFileSync(join(dir, '.bench-page.html'), html);
      // the visitor-facing boot, measured in the web server (opcache on), median of 7 token requests
      const boots: number[] = [];
      for (let i = 0; i < 8; i++) boots.push((await agent.diag('http://localhost:8888/'))!.serverTiming['sp-agent-booted']!);
      const b = bench('/var/www/agent-tests/.bench-page.html');
      if (state === 'on') expect(b.enabled.length).toBe(Object.keys(ALL_ON).length);
      const bootMs = summarize(boots.slice(1)).median!;
      results[state] = { bootMs, callbacksMs: b.callbacksMs, queriesAdded: b.queriesAdded, total: bootMs + b.callbacksMs };
    }
    writeFileSync(join(mkdtempSync(join(tmpdir(), 'sp-bench-')), 'overhead.json'), JSON.stringify(results, null, 2));
    for (const [state, r] of Object.entries(results)) {
      expect(r.total, `${state}: ${JSON.stringify(r)}`).toBeLessThan(2);
      expect(r.queriesAdded, state).toBe(0);
    }
    // the full page: no extra queries with everything on (query-cache may remove some)
    await setAll(false);
    const off = (await agent.diag('http://localhost:8888/about/'))!.diag!.query_count!;
    await setAll(true);
    const on = (await agent.diag('http://localhost:8888/about/'))!.diag!.query_count!;
    expect(on).toBeLessThanOrEqual(off);
  }, 300_000);

  it('turns off cleanly by flag and by SPEEDPILOT_DISABLE', async () => {
    await setAll(true);
    for (const key of Object.keys(ALL_ON)) {
      await wp.text(['speedpilot', 'disable', key]);
      const doc = await readFlags(wp);
      expect(doc.modules[key]!.enabled).toBe(false);
    }
    const html = await page();
    for (const marker of ['speedpilot-fonts', 'speedpilot-delay-loader', 'speedpilot-critical-css', 'speedpilot-css-fixes', 'speedpilot-interaction-yield', 'data-speedpilot-facade', 'text/speedpilot-delayed']) expect(html, marker).not.toContain(marker);
    expect(/<img[^>]*hero\.jpg[^>]*>/.exec(html)?.[0]).toContain('loading="lazy"');
    // the kill switch: every module on, SPEEDPILOT_DISABLE set, nothing of the agent left in the page
    await setAll(true);
    const out = execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', 'cli', 'wp', "--exec=define('SPEEDPILOT_DISABLE', true);", 'eval-file', '/var/www/agent-tests/kill-switch-test.php'], { encoding: 'utf8' });
    expect(out).toMatch(/^ok/m);
    expect(out).not.toMatch(/^not ok/m);
  }, 180_000);
});
