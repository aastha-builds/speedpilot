import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createLogger, redact, redactString } from './log.js';
import { initSiteYaml, parseSite, writeSiteYaml, loadSite } from './config/site.js';
import { Store } from './store/store.js';
import { MIGRATIONS } from './store/db.js';
import { writeApproval, requireApproval, ApprovalError } from './approvals.js';
import { accessCheck } from './access/check.js';

describe('site.yaml', () => {
  it('speedpilot init writes a site.yaml that validates, with intake TODOs', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    const p = writeSiteYaml(root, 'demo', 'wordpress', 'https://demo.example.com/');
    const text = readFileSync(p, 'utf8');
    expect(text).toMatch(/TODO: Written permission/);
    expect(text).toMatch(/TODO: Which pages and flows make the business money/);
    const cfg = loadSite(root, 'demo');
    expect(cfg.platform).toBe('wordpress');
    expect(cfg.access.wordpress?.restAppPassword).toBe('WP_DEMO_REST_APP_PASSWORD');
    expect(parseSite(initSiteYaml('shop', 'shopify')).access.shopify?.store).toBe('shop.myshopify.com');
  });
  it('rejects secrets in access fields', () => {
    const bad = initSiteYaml('demo').replace('WP_DEMO_REST_APP_PASSWORD', 'abcd efgh ijkl mnop qrst uvwx');
    expect(() => parseSite(bad)).toThrow(/NAMES/);
  });
  it('rejects unknown keys', () => {
    expect(() => parseSite(initSiteYaml('demo') + '\nfoo: 1\n')).toThrow();
  });
});

describe('secrets never appear in logs', () => {
  it('redacts by key, by env value and by token shape', () => {
    process.env.WP_DEMO_REST_APP_PASSWORD = 'Xk2p QQ9r aaaa bbbb cccc dddd';
    process.env.SHOPIFY_DEMO_THEME_ACCESS_PASSWORD = 'shptka_0123456789abcdef0123456789abcdef';
    process.env.GOOGLE_API_KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstuv';
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const logger = createLogger({ destination: dest as never, level: 'debug' });
    logger.info({ password: 'hunter2', nested: { token: 'abc', headers: { Authorization: 'Basic Zm9vOmJhcg==' } } }, 'connecting');
    logger.info(`calling with ${process.env.WP_DEMO_REST_APP_PASSWORD} and ${process.env.SHOPIFY_DEMO_THEME_ACCESS_PASSWORD}`);
    logger.info(`psi https://x/runPagespeed?url=a&key=${process.env.GOOGLE_API_KEY}`);
    logger.warn({ cookie: 'wordpress_logged_in_abc=secretvalue' }, 'cookie: wordpress_logged_in_abc=secretvalue');
    const all = lines.join('\n');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('Zm9vOmJhcg==');
    expect(all).not.toContain('Xk2p QQ9r');
    expect(all).not.toContain('shptka_0123');
    expect(all).not.toContain('AIzaSyA1234');
    expect(all).not.toContain('secretvalue');
    expect(all).toContain('[REDACTED]');
  });
  it('redact() walks objects', () => {
    expect(redact({ a: { apiKey: 'x' }, b: ['Authorization: Bearer abc.def'] })).toEqual({ a: { apiKey: '[REDACTED]' }, b: ['Authorization: Bearer [REDACTED]'] });
    expect(redactString('?token=abc&x=1', [])).toBe('?token=[REDACTED]&x=1');
  });
});

describe('store', () => {
  it('migrates and stores the data model', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    const store = new Store(root, ':memory:');
    const v = store.db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number };
    expect(v.v).toBe(MIGRATIONS.length);
    const cfg = parseSite(initSiteYaml('demo'));
    store.upsertSite(cfg);
    const run = store.startRun('demo', 'audit', 'production', { lighthouse: '13.5.0' });
    store.addMetric({ runId: run.id, url: 'https://x/', device: 'mobile', source: 'lab', name: 'lcp', median: 2100, min: 2000, max: 2300, samples: [2000, 2100, 2300] });
    store.addFinding({ id: 'f1', runId: run.id, checkId: 'IMG-01', urls: ['https://x/'], evidence: {}, metric: 'LCP', estimatedGain: { lcp: 800 }, tier: 'T1', fix: 'eager', priority: 10 });
    store.endRun(run.id, 'ok');
    expect(store.latestRun('demo', 'audit')?.id).toBe(run.id);
    expect(store.findings(run.id)[0]?.checkId).toBe('IMG-01');
    expect(store.metrics(run.id)[0]?.median).toBe(2100);
    store.close();
  });
});

describe('approvals (executor check)', () => {
  it('requires a fresh matching approval naming the item', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-'));
    expect(() => requireApproval(root, { site: 'demo', operation: 'p1', stage: 'staging', item: 'c1' })).toThrow(ApprovalError);
    writeApproval(root, { site: 'demo', stage: 'staging', operation: 'p1', items: ['c1'], approvedBy: 'Ann' });
    expect(requireApproval(root, { site: 'demo', operation: 'p1', stage: 'staging', item: 'c1' }).approvedBy).toBe('Ann');
    expect(() => requireApproval(root, { site: 'demo', operation: 'p1', stage: 'staging', item: 'c2' })).toThrow(/not approved/);
    expect(() => requireApproval(root, { site: 'demo', operation: 'p1', stage: 'production', item: 'c1' })).toThrow();
    expect(() => requireApproval(root, { site: 'demo', operation: 'p1', stage: 'staging', item: 'c1', now: Date.now() + 25 * 3600_000 })).toThrow(/24 hours/);
    const f = join(root, 'runs/demo/approvals/p1.staging.json');
    const a = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...a, site: 'other' }));
    expect(() => requireApproval(root, { site: 'demo', operation: 'p1', stage: 'staging', item: 'c1' })).toThrow(/match/);
  });
});

describe('access check', () => {
  it('runs read-only probes and never leaks secrets', async () => {
    const cfg = parseSite(initSiteYaml('demo', 'shopify'));
    const env = { SHOPIFY_DEMO_THEME_ACCESS_PASSWORD: 'shptka_secretsecretsecretsecret', SHOPIFY_DEMO_ADMIN_TOKEN: 'shpat_secretsecretsecretsecret00' };
    const calls: string[][] = [];
    const results = await accessCheck(cfg, {
      env,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 0, stdout: JSON.stringify([{ role: 'live' }, { role: 'unpublished' }]), stderr: '' };
      },
      fetch: (async (_url: string, init: RequestInit) => {
        expect(String(init.body)).toMatch(/^\{"query":"\{ shop/);
        return new Response(JSON.stringify({ data: { shop: { name: 'Demo' } } }), { status: 200 });
      }) as never,
    });
    expect(calls[0]).toEqual(['shopify', 'theme', 'list', '--store', 'demo.myshopify.com', '--json']);
    expect(results.find((r) => r.probe === 'Shopify CLI theme list')?.ok).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/secretsecret/);
  });
});
