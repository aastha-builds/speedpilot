import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, releaseBrowser, openSession, collectPage, measureInteractions, INTERACTIONS, ownerOf, classify, pickSample, internalLinks, buildAuditMap, AUDIT_CANDIDATES, matchBeacon, sessionWindowCls, usedJsBytes } from '@speedpilot/core';

// A "public" site stand-in: SpeedPilot treats it as production (local: false), so every mutating request
// must be blocked and every beacon recorded then aborted.
let server: Server;
let base = '';
const hits: Array<{ method: string; path: string }> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ method: req.method!, path: req.url! });
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Public</title><link rel="canonical" href="/"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>Public page</h1><img src="/big.svg" alt="x">
<form id="f" method="post" action="/subscribe"><input name="e" value="a@b.c"><button id="sub">Subscribe</button></form>
<button id="b" type="button">Do</button>
<script>
fetch('/api/track', { method: 'POST', body: '{}' }).catch(()=>{});
navigator.sendBeacon('/g/collect?v=2&en=page_view');
fetch('https://www.facebook.com/tr?ev=PageView').catch(()=>{});
document.getElementById('b').addEventListener('click', function(){ fetch('/api/x', { method: 'DELETE' }).catch(()=>{}); });
</script></body></html>`);
      return;
    }
    if (req.url === '/big.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="red"/></svg>');
      return;
    }
    res.writeHead(204).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('read-only collection against a production-like site', () => {
  it('sends no POST, PUT, PATCH or DELETE and lets no analytics beacon leave the browser', async () => {
    const out = mkdtempSync(join(tmpdir(), 'sp-col-'));
    for (const d of ['screenshots', 'traces', 'logs']) mkdirSync(join(out, d));
    const browser = await launchBrowser();
    try {
      const session = await openSession(browser, { device: 'mobile', local: false });
      const ev = await collectPage(session, base + '/', 'mobile', {
        outDir: out,
        ownerCtx: { siteOrigin: base, platform: 'wordpress' },
        screenshots: true,
        interact: async (p) => {
          await p.click('#b');
          await p.click('#sub').catch(() => {});
        },
      });
      await measureInteractions(session, base + '/', [INTERACTIONS.heavyButton!], { siteOrigin: base, platform: 'wordpress' });
      await session.close();
      expect(hits.filter((h) => h.method !== 'GET' && h.method !== 'HEAD')).toEqual([]);
      expect(hits.some((h) => h.path.startsWith('/g/collect'))).toBe(false);
      expect(session.mutationsSent).toEqual([]);
      expect(session.blockedMutations.map((m) => m.method)).toEqual(expect.arrayContaining(['POST', 'DELETE']));
      expect(ev.beacons.map((b) => b.vendor)).toEqual(expect.arrayContaining(['ga4', 'meta-pixel']));
      expect(ev.beacons.find((b) => b.vendor === 'ga4')?.event).toBe('page_view');
      expect(ev.seo.title).toBe('Public');
      expect(ev.screenshots.length).toBeGreaterThanOrEqual(6);
    } finally {
      await releaseBrowser();
    }
  });
});

describe('collector units', () => {
  it('attributes owners', () => {
    const wp = { siteOrigin: 'https://shop.example', platform: 'wordpress' as const };
    expect(ownerOf('https://shop.example/wp-content/plugins/contact-form-7/includes/js/index.js', wp).id).toBe('plugin:contact-form-7');
    expect(ownerOf('https://shop.example/wp-content/themes/astra/style.css', wp).id).toBe('theme:astra');
    expect(ownerOf('https://shop.example/wp-includes/js/jquery/jquery.min.js', wp).id).toBe('core:wordpress');
    expect(ownerOf('https://www.googletagmanager.com/gtag/js?id=G-1', wp).id).toBe('third-party:google-tag-manager');
    expect(ownerOf('https://shop.example/wp-content/uploads/elementor/css/post-1.css', wp).id).toBe('plugin:elementor');
    const sh = { siteOrigin: 'https://store.example', platform: 'shopify' as const };
    expect(ownerOf('https://store.example/cdn/shop/t/12/assets/theme.js', sh).id).toBe('theme:theme');
    expect(ownerOf('https://cdn.shopify.com/extensions/0193a-b/judge-me-reviews-123/assets/x.js', sh).id).toBe('app:judge-me-reviews');
    expect(ownerOf('https://store.example/cdn/shopifycloud/web-pixels-manager/x.js', sh).id).toBe('platform:shopify');
    expect(ownerOf('https://static.klaviyo.com/onsite/js/klaviyo.js', sh).id).toBe('app:klaviyo');
  });
  it('classifies templates and samples', () => {
    expect(classify('https://x.com/', 'wordpress')).toBe('home');
    expect(classify('https://x.com/product/a/', 'wordpress')).toBe('product');
    expect(classify('https://x.com/category/news/', 'wordpress')).toBe('archive');
    expect(classify('https://x.com/products/a', 'shopify')).toBe('product');
    expect(classify('https://x.com/collections/all', 'shopify')).toBe('collection');
    expect(classify('https://x.com/?s=a', 'wordpress')).toBe('search');
    const all = ['/', '/a/', '/b/', '/product/p/', '/category/c/', '/contact/', '/cart/', '/checkout/'].map((p, i) => ({ url: 'https://x.com' + p, template: classify('https://x.com' + p, 'wordpress'), source: 'sitemap' as const, traffic: 10 - i }));
    const s = pickSample(all, 12);
    expect(s[0]!.template).toBe('home');
    expect(s.some((u) => u.template === 'checkout')).toBe(false);
    expect(new Set(s.map((u) => u.template))).toEqual(new Set(['home', 'page', 'product', 'archive', 'contact', 'cart']));
    expect(internalLinks('<a href="/a">a</a><a href="/a">a</a><a href="/?add-to-cart=1">x</a><a href="https://o.com/">o</a>', 'https://x.com/')).toEqual([{ url: 'https://x.com/a', count: 2 }]);
  });
  it('fails loudly when a mapped audit is missing and resolves 13.x renames', () => {
    const all = Object.values(AUDIT_CANDIDATES).map((c) => c[c.length - 1]!);
    expect(buildAuditMap(all).useCache).toBe('cache-insight');
    expect(() => buildAuditMap(all.filter((a) => a !== 'render-blocking-insight'))).toThrow(/render-blocking-insight/);
  });
  it('matches beacons, computes CLS windows and JS coverage', () => {
    expect(matchBeacon('https://region1.google-analytics.com/g/collect?v=2&en=page_view')?.vendor).toBe('ga4');
    expect(matchBeacon('https://www.googletagmanager.com/gtag/js?id=G-1')).toBeUndefined();
    expect(sessionWindowCls([{ value: 0.1, startTime: 0 }, { value: 0.1, startTime: 500 }, { value: 0.05, startTime: 3000 }])).toBe(0.2);
    expect(usedJsBytes([{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 40, count: 0 }] }], 100)).toBe(70);
  });
});
