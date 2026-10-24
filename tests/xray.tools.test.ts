import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { loadSite, Store } from '@speedpilot/core';
import { xrayRun, competitorBenchmark, robotsAllows, logVerdicts, recordVerdictOutcome, verdictPrecision, anonymizedExport, loadRecipes, rankFixes, type Verdict } from '@speedpilot/xray';
import { xrayTools, capAnswer, allTools, MAX_ANSWER_BYTES } from '@speedpilot/mcp-server';
import { ensureFixturePreview, stopFixturePreview } from '@speedpilot/shopify';
import { REPO, tempRoot } from './helpers.js';

describe('competitor benchmark (public data and one normal visit each)', () => {
  const hits = new Map<string, number>();
  const servers: Server[] = [];
  const start = (name: string, page: string, robots = 'User-agent: *\nDisallow: /private/') =>
    new Promise<string>((resolve) => {
      const s = createServer((req, res) => {
        const k = `${name}${req.url}`;
        hits.set(k, (hits.get(k) ?? 0) + 1);
        if (req.url === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end(robots);
        if (req.url === '/app.js') return res.writeHead(200, { 'content-type': 'application/javascript' }).end(`/* ${name} */` + 'var x=1;'.repeat(name === 'slow' ? 40000 : 200));
        if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
        res.writeHead(404).end();
      });
      servers.push(s);
      s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    });
  let client: string;
  let fast: string;
  let other: string;
  beforeAll(async () => {
    client = await start('slow', '<!doctype html><title>client</title><script src="/app.js"></script><h1 style="font-size:40px">Client shop</h1><p>text</p>');
    fast = await start('fast', '<!doctype html><title>fast</title><h1 style="font-size:40px">Fast competitor</h1><script src="/app.js" defer></script>');
    other = await start('other', '<!doctype html><title>other</title><h1>Other competitor</h1><script src="/app.js"></script>');
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it('visits each URL once, respects robots.txt and produces the comparison table', async () => {
    const t = await competitorBenchmark(`${client}/`, [`${fast}/`, `${other}/`]);
    expect(t.rows).toHaveLength(3);
    for (const name of ['slow', 'fast', 'other']) expect(hits.get(`${name}/`), name).toBe(1);
    expect(t.markdown).toMatch(/\| Site \| Field LCP/);
    expect(t.markdown.split('\n')).toHaveLength(5);
    expect(t.rows[0]!.jsBytes).toBeGreaterThan(t.rows[1]!.jsBytes);
    expect(t.plainWords).toMatch(/nothing was copied|No competitor/);
    expect(await robotsAllows(`${fast}/private/x`)).toBe(false);
  }, 180_000);
});

describe('X-ray MCP tools', () => {
  let root: string;
  beforeAll(async () => {
    root = tempRoot(['fixture-shopify']);
    await ensureFixturePreview(REPO, loadSite(root, 'fixture-shopify'));
    await xrayRun(root, 'fixture-shopify', { urls: ['http://localhost:9292/'], themeDir: join(REPO, 'fixtures/shopify/theme') });
  }, 600_000);
  afterAll(() => stopFixturePreview());

  it('has at most 10 X-ray tools with the names from SPEC.md 15.9', () => {
    const names = xrayTools(root).map((t) => t.name);
    expect(names.length).toBeLessThanOrEqual(10);
    for (const n of ['xray_run', 'xray_summary', 'xray_explain', 'xray_is_safe', 'xray_simulate', 'xray_owner_costs', 'xray_interactions', 'xray_waterfall', 'xray_diff']) expect(names).toContain(n);
    expect(allTools(root).length).toBeGreaterThanOrEqual(names.length);
  });

  it('answers under 20 KB with evidence paths', async () => {
    const tools = new Map(xrayTools(root).map((t) => [t.name, t]));
    for (const [name, args] of [['xray_summary', {}], ['xray_explain', { ref: 'vendor-slider.js' }], ['xray_is_safe', { change: 'defer:vendor-slider.js' }], ['xray_owner_costs', {}], ['xray_interactions', {}], ['xray_waterfall', {}]] as const) {
      const res = capAnswer(await tools.get(name)!.run({ site: 'fixture-shopify', ...args }));
      expect(Buffer.byteLength(JSON.stringify(res)), name).toBeLessThan(MAX_ANSWER_BYTES);
      expect(Array.isArray(res.evidence) && (res.evidence as string[]).length > 0, name).toBe(true);
    }
    const v = await tools.get('xray_is_safe')!.run({ site: 'fixture-shopify', change: 'defer:vendor-slider.js' });
    expect(v.verdict).toBe('unsafe');
  });

  it('caps oversized answers', () => {
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, text: 'x'.repeat(100) })), evidence: ['a'] };
    const c = capAnswer(big);
    expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThan(MAX_ANSWER_BYTES);
    expect(c.truncated).toBeTruthy();
  });
});

describe('learning loop and shadow mode', () => {
  it('logs verdicts, lowers recipe confidence after a failed safe verdict, tracks precision and exports anonymized data', () => {
    const root = tempRoot([]);
    const store = new Store(root);
    try {
      store.upsertSite({ ...loadSite(REPO, 'fixture-wp'), name: 'acme-shop' } as never);
      const recipes = loadRecipes(REPO);
      const cf7 = recipes.find((r) => r.id === 'wp-plugin-contact-form-7')!;
      const v = (change: string, verdict: Verdict['verdict'], recipe?: string): Verdict => ({ change, verdict, target: change.split(':')[1]!, pages: [], reasons: [], confidence: 0.8, explanation: '', recipe });
      logVerdicts(store.db, 'acme-shop', 'run-1', [v('remove-template:contact-form-7@home', 'safe', cf7.id), v('defer:footer', 'safe'), v('defer:jquery-core', 'unsafe')]);
      const r1 = recordVerdictOutcome(store.db, 'acme-shop', 'remove-template:contact-form-7@home', false, 'form broke on https://acme-shop.com/about', recipes);
      expect(r1.verdict).toBe('safe');
      expect(r1.recipeConfidence!).toBeLessThan(cf7.confidence);
      recordVerdictOutcome(store.db, 'acme-shop', 'defer:footer', true, 'passed', recipes);
      const p = verdictPrecision(store.db);
      expect(p.find((x) => x.changeType === 'remove-template')!.precision).toBe(0);
      expect(p.find((x) => x.changeType === 'defer')!.precision).toBe(1);
      store.addOutcome({ changeId: 'c1', checkOrRecipeId: 'WPF-01', platform: 'wordpress', target: 'https://acme-shop.com/', kept: true, before: { lcp: 3000 }, after: { lcp: 2500 }, reason: 'kept on acme-shop.com' });
      store.addOutcome({ changeId: 'c2', checkOrRecipeId: 'JS-05', platform: 'wordpress', kept: false, reason: 'console error' });
      const exp = JSON.stringify(anonymizedExport(store.db));
      expect(exp).not.toMatch(/acme-shop/);
      const ranked = rankFixes(store, 'wordpress', [{ checkOrRecipeId: 'JS-05', estimatedGainMs: 900 }, { checkOrRecipeId: 'WPF-01', estimatedGainMs: 100 }]);
      expect(ranked[0]!.checkOrRecipeId).toBe('WPF-01');
    } finally {
      store.close();
    }
  });
});
